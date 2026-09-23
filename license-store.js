const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'licenses.json');
let mongoClient = null;
let collection = null;

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}
function generateKey() {
  const raw = crypto.randomBytes(18).toString('base64url').toUpperCase();
  return `ALFA-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}`;
}
function ensureLocal() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCAL_FILE)) fs.writeFileSync(LOCAL_FILE, '[]');
}
function localRead() { ensureLocal(); return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')); }
function localWrite(items) { ensureLocal(); fs.writeFileSync(LOCAL_FILE, JSON.stringify(items, null, 2)); }

async function initStore() {
  if (process.env.MONGODB_URI) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db(process.env.MONGODB_DB || 'alfa_strategy');
    collection = db.collection('licenses');
    await collection.createIndex({ keyHash: 1 }, { unique: true });
    await collection.createIndex({ status: 1, expiresAt: 1 });
    return { mode: 'mongodb' };
  }
  ensureLocal();
  return { mode: 'local-json' };
}

function clean(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id || doc.id),
    key: doc.key || null,
    maskedKey: doc.maskedKey || (doc.key ? doc.key.slice(0, 9) + '••••••••' : '••••••••'),
    planDays: doc.planDays,
    createdAt: doc.createdAt,
    activatedAt: doc.activatedAt || null,
    expiresAt: doc.expiresAt,
    status: doc.status,
    activations: doc.activations || 0,
    maxDevices: doc.maxDevices || 1,
    devicesUsed: Array.isArray(doc.deviceIds) ? doc.deviceIds.length : 0,
    lastValidatedAt: doc.lastValidatedAt || null
  };
}

async function createLicense(planDays, maxDevices = 1) {
  const isLifetime = planDays === 'lifetime' || Number(planDays) === 0;
  if (!isLifetime && ![1, 3, 7, 14, 30].includes(Number(planDays))) throw new Error('planDays must be 1, 3, 7, 14, 30, or "lifetime"');
  const key = generateKey();
  const now = new Date();
  const doc = {
    keyHash: hashKey(key),
    maskedKey: key.slice(0, 9) + '••••••••',
    planDays: isLifetime ? 0 : Number(planDays),
    createdAt: now,
    activatedAt: null,
    expiresAt: null,
    status: 'unused',
    activations: 0,
    maxDevices: Math.max(1, Math.min(20, Number(maxDevices) || 1)),
    deviceIds: [],
    lastValidatedAt: null
  };
  if (collection) {
    const r = await collection.insertOne(doc);
    return { ...clean({ ...doc, _id: r.insertedId }), key };
  }
  const items = localRead();
  const localDoc = { ...doc, id: crypto.randomUUID() };
  items.push(localDoc); localWrite(items);
  return { ...clean(localDoc), key };
}

async function listLicenses() {
  const now = new Date();
  if (collection) {
    await collection.updateMany({ status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
    const docs = await collection.find({}).sort({ createdAt: -1 }).limit(1000).toArray();
    return docs.map(clean);
  }
  const items = localRead().map(x => {
    if (x.status === 'active' && x.expiresAt && new Date(x.expiresAt) <= now) x.status = 'expired';
    return x;
  }); localWrite(items); return items.map(clean);
}

async function revokeLicense(id) {
  if (collection) {
    const { ObjectId } = require('mongodb');
    if (!ObjectId.isValid(id)) return false;
    const r = await collection.updateOne({ _id: new ObjectId(id) }, { $set: { status: 'revoked' } });
    return r.modifiedCount > 0;
  }
  const items = localRead(); const item = items.find(x => String(x.id) === String(id));
  if (!item) return false; item.status = 'revoked'; localWrite(items); return true;
}

async function validateLicense(key, deviceId = '') {
  const keyHash = hashKey(String(key || '').trim().toUpperCase());
  let doc;
  if (collection) doc = await collection.findOne({ keyHash });
  else doc = localRead().find(x => x.keyHash === keyHash);
  if (!doc) return { valid: false, reason: 'INVALID_KEY' };

  const now = new Date();
  if (doc.status === 'revoked') return { valid: false, reason: 'REVOKED' };
  if (doc.expiresAt && new Date(doc.expiresAt) <= now) {
    if (collection) await collection.updateOne({ _id: doc._id }, { $set: { status: 'expired' } });
    else { doc.status = 'expired'; localWrite(localRead().map(x => x.keyHash === keyHash ? doc : x)); }
    return { valid: false, reason: 'EXPIRED' };
  }

  // Every key is bound to specific device IDs (max = maxDevices, default 1).
  // A device ID is required to bind/check a slot - without one, an
  // unlimited number of "anonymous" callers could each pass the key
  // string and all be treated as valid, which is exactly the bug this
  // closes (same key working on multiple devices at once).
  const cleanDeviceId = String(deviceId || '').trim();
  if (!cleanDeviceId) return { valid: false, reason: 'DEVICE_ID_REQUIRED' };
  const existingDeviceIds = Array.isArray(doc.deviceIds) ? doc.deviceIds : [];
  const knownDevice = existingDeviceIds.includes(cleanDeviceId);
  if (!knownDevice && existingDeviceIds.length >= (doc.maxDevices || 1)) {
    return { valid: false, reason: 'DEVICE_LIMIT_REACHED' };
  }
  const nextDeviceIds = knownDevice ? existingDeviceIds : [...existingDeviceIds, cleanDeviceId];

  if (doc.status === 'unused') {
    const isLifetime = !doc.planDays || Number(doc.planDays) === 0;
    const expiresAt = isLifetime ? null : new Date(now.getTime() + Number(doc.planDays) * 86400000);
    const update = { $set: { status: 'active', activatedAt: now, expiresAt, lastValidatedAt: now, deviceIds: nextDeviceIds }, $inc: { activations: 1 } };
    if (collection) { await collection.updateOne({ _id: doc._id }, update); doc.status='active'; doc.activatedAt=now; doc.expiresAt=expiresAt; doc.activations=(doc.activations||0)+1; doc.lastValidatedAt=now; doc.deviceIds=nextDeviceIds; }
    else { doc.status='active'; doc.activatedAt=now; doc.expiresAt=expiresAt; doc.activations=(doc.activations||0)+1; doc.lastValidatedAt=now; doc.deviceIds=nextDeviceIds; localWrite(localRead().map(x => x.keyHash === keyHash ? doc : x)); }
  } else {
    if (collection) await collection.updateOne({ _id: doc._id }, { $set: { lastValidatedAt: now, deviceIds: nextDeviceIds } });
    else { doc.lastValidatedAt=now; doc.deviceIds=nextDeviceIds; localWrite(localRead().map(x => x.keyHash === keyHash ? doc : x)); }
  }

  return { valid: true, planDays: doc.planDays, status: 'active', expiresAt: doc.expiresAt, maxDevices: doc.maxDevices };
}

module.exports = { initStore, createLicense, listLicenses, revokeLicense, validateLicense };
