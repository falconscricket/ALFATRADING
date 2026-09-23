/**
 * tick-store.js
 * -----------------------------------------------------------------------
 * Centralized, server-side version of the tick-to-candle builder.
 * Any device (phone, PC, etc) can POST ticks here via /api/ingest-ticks,
 * and any device can then ask for a signal without needing its own local
 * history - the server already has it.
 *
 * Persistence:
 *   - If MONGODB_URI is set (same variable license-store.js already
 *     uses), the candle store snapshot is saved to a single MongoDB
 *     document and reloaded from there on startup. This survives
 *     Render's free-tier ephemeral filesystem (spin-down after 15 min
 *     idle wipes local disk, but MongoDB Atlas is a separate service).
 *   - If MONGODB_URI is NOT set, falls back to the original local JSON
 *     file behavior (fine for Railway with a Volume, or plain local
 *     testing) - nothing changes for setups that don't use Mongo.
 * -----------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const TIMEFRAME_SECONDS = { "1m": 60, "3m": 180, "5m": 300, "30m": 1800, "1h": 3600, "4h": 14400 };
const MAX_CANDLES_PER_TF = 300;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "candles.json");

// store[symbol][tf] = { current: {time,open,high,low,close}|null, history: [...] }
let store = {};

let mode = "local-json"; // or "mongodb"
let mongoClient = null;
let collection = null;

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    /* ignore - directory may already exist */
  }
}

async function initStore() {
  if (process.env.MONGODB_URI) {
    try {
      mongoClient = new MongoClient(process.env.MONGODB_URI);
      await mongoClient.connect();
      const db = mongoClient.db(process.env.MONGODB_DB || "alfa_strategy");
      collection = db.collection("tickstore");
      mode = "mongodb";

      const doc = await collection.findOne({ _id: "snapshot" });
      if (doc && doc.data) {
        store = doc.data;
        console.log("Tick store loaded from MongoDB Atlas");
      } else {
        console.log("Tick store starting fresh in MongoDB Atlas");
      }
      return;
    } catch (e) {
      console.warn("MongoDB unavailable for tick store, falling back to local JSON:", e.message);
      mode = "local-json";
    }
  }

  // Local JSON fallback
  ensureDataDir();
  try {
    if (fs.existsSync(STORE_FILE)) {
      store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      console.log(`Tick store loaded from ${STORE_FILE}`);
    }
  } catch (e) {
    console.warn("Could not load local tick store, starting fresh:", e.message);
    store = {};
  }
}

async function save() {
  if (mode === "mongodb" && collection) {
    try {
      await collection.updateOne(
        { _id: "snapshot" },
        { $set: { data: store, updatedAt: new Date() } },
        { upsert: true }
      );
      return;
    } catch (e) {
      console.warn("Could not save tick store to MongoDB:", e.message);
      return;
    }
  }

  ensureDataDir();
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store));
  } catch (e) {
    console.warn("Could not save tick store:", e.message);
  }
}

function getBuilder(symbol, tf) {
  if (!store[symbol]) store[symbol] = {};
  if (!store[symbol][tf]) store[symbol][tf] = { current: null, history: [] };
  return store[symbol][tf];
}

function ingestTick(symbol, tMs, price) {
  if (!symbol || typeof price !== "number" || typeof tMs !== "number") return;

  for (const tf of Object.keys(TIMEFRAME_SECONDS)) {
    const periodMs = TIMEFRAME_SECONDS[tf] * 1000;
    const bucketStart = Math.floor(tMs / periodMs) * periodMs;
    const b = getBuilder(symbol, tf);

    // Multiple devices forward ticks to this same store (that's the whole
    // point of "shared server history"), in batches, over the network -
    // so ticks for the same symbol are NOT guaranteed to arrive in time
    // order here. Previously, a late/out-of-order tick for an OLDER bucket
    // than the one already in progress would still be treated as "a new
    // bucket", pushing the real in-progress candle into history early and
    // starting a new "current" candle stamped with the OLDER time - which
    // corrupts chronological order for every indicator downstream (RSI,
    // EMA, MACD etc. all assume oldest->newest). A tick for a bucket
    // that's already closed (older than the latest history candle) is
    // just dropped instead of rewriting settled history.
    const lastClosed = b.history[b.history.length - 1];
    if (lastClosed && bucketStart < lastClosed.time) continue;
    if (b.current && bucketStart < b.current.time) continue;

    if (!b.current || b.current.time !== bucketStart) {
      if (b.current) {
        b.history.push(b.current);
        if (b.history.length > MAX_CANDLES_PER_TF) b.history.shift();
      }
      b.current = { time: bucketStart, open: price, high: price, low: price, close: price };
    } else {
      b.current.high = Math.max(b.current.high, price);
      b.current.low = Math.min(b.current.low, price);
      b.current.close = price;
    }
  }
}

// Only fully-closed candles - same "no flicker" rule as the client.
// This store persists across server restarts/redeploys (Mongo or local
// JSON, see header comment above). A Render free-tier spin-down/restart,
// or just this candle set going quiet for a while, means the array can
// contain an old session's candles glued directly onto a new session's
// with a multi-hour+ gap between two adjacent array entries -
// MAX_CANDLES_PER_TF (300) counts array length, not real continuity, so
// "300 candles" can be technically true while the real unbroken recent
// block is much smaller. Trim to the trailing continuous block before
// handing candles to evaluateSignal or to any /api/candles caller.
function trimToContinuousBlock(history, tf) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const periodMs = (TIMEFRAME_SECONDS[tf] || 60) * 1000;
  const maxGapMs = periodMs * 2;
  let startIdx = history.length - 1;
  for (let i = history.length - 1; i > 0; i--) {
    const gap = history[i].time - history[i - 1].time;
    if (gap > maxGapMs) { startIdx = i; break; }
    startIdx = i - 1;
  }
  return history.slice(startIdx);
}

function getCandles(symbol, tf) {
  const b = store[symbol]?.[tf];
  if (!b || b.history.length === 0) return null;
  return trimToContinuousBlock(b.history, tf);
}

function getCandleCount(symbol, tf) {
  const b = store[symbol]?.[tf];
  if (!b || !b.history.length) return 0;
  return trimToContinuousBlock(b.history, tf).length;
}

function getMode() {
  return mode;
}

// initStore() is async (Mongo connect), but ingestTick() etc. are called
// synchronously all over server.js right away. That's fine - ingestTick
// just writes to the in-memory `store` object either way; the only thing
// that depends on initStore() finishing is which backend save()/load()
// use, and the periodic save() calls below only start after init.
initStore().then(() => {
  setInterval(save, 15000);
});

process.on("SIGTERM", async () => { await save(); process.exit(0); });

module.exports = { ingestTick, getCandles, getCandleCount, getMode, TIMEFRAME_SECONDS };
