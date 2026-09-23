const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { evaluateSignal } = require('./indicators');
const tickStore = require('./tick-store');
const strategyConfig = require('./strategy-config');
const licenseStore = require('./license-store');

// Multi-timeframe confirmation: which timeframe counts as "higher" than
// each entry timeframe, within the set this project actually supports
// (1m/3m/5m/30m/1h/4h). 4h has no higher option here, so MTF is simply
// skipped for it (evaluateSignal treats missing MTF as neutral).
const HIGHER_TIMEFRAME = { '1m': '5m', '3m': '30m', '5m': '30m', '30m': '1h', '1h': '4h', '4h': null };

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Admin panel URL path - change ADMIN_PATH env var on Render (no code edit
// needed) if you want something other than the default "/admin".
const ADMIN_PATH = (process.env.ADMIN_PATH || '/admin').replace(/\/+$/, '') || '/admin';
app.use(ADMIN_PATH, express.static(path.join(__dirname, 'admin')));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const REQUIRE_LICENSE = String(process.env.REQUIRE_LICENSE || 'false').toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token || !SESSION_SECRET) return false;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now(); } catch { return false; }
}
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifySession(token)) return res.status(401).json({ ok: false, error: 'ADMIN_AUTH_REQUIRED' });
  next();
}

app.get(ADMIN_PATH, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get(`${ADMIN_PATH}/`, (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD || !SESSION_SECRET) return res.status(503).json({ ok: false, error: 'ADMIN_SECRETS_NOT_CONFIGURED' });
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  const token = signSession({ sub: ADMIN_USER, exp: Date.now() + 12 * 60 * 60 * 1000 });
  res.json({ ok: true, token, expiresIn: 43200 });
});

app.get('/api/admin/licenses', adminAuth, async (_req, res) => {
  try { res.json({ ok: true, licenses: await licenseStore.listLicenses() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/licenses/generate', adminAuth, async (req, res) => {
  try {
    const { days, maxDevices } = req.body || {};
    // days: 7 | 14 | 30, or "lifetime" (or 0) for a permanent key.
    const planDays = (days === 'lifetime' || Number(days) === 0) ? 'lifetime' : Number(days);
    const result = await licenseStore.createLicense(planDays, Number(maxDevices || 1));
    res.json({ ok: true, license: result });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/licenses/:id/revoke', adminAuth, async (req, res) => {
  try {
    const ok = await licenseStore.revokeLicense(req.params.id);
    res.status(ok ? 200 : 404).json({ ok, error: ok ? undefined : 'LICENSE_NOT_FOUND' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/license/validate', async (req, res) => {
  try {
    const { key, deviceId } = req.body || {};
    if (!key) return res.status(400).json({ valid: false, reason: 'KEY_REQUIRED' });
    res.json(await licenseStore.validateLicense(key, deviceId));
  } catch (e) { res.status(500).json({ valid: false, reason: 'SERVER_ERROR' }); }
});

function guessBrokerSymbols(uiAsset) {
  const raw = String(uiAsset || '').trim().toUpperCase();
  if (!raw) return [];

  // Binance public-feed symbols are stored without the UI provider suffix.
  const binanceBase = raw.replace(/\s*\(BINANCE\)\s*$/, '');
  const binance = binanceBase.replace(/[\s\/:\-]+/g, '').replace(/[^A-Z0-9]/g, '');
  const binanceSymbols = new Set(['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','LTCUSDT']);
  if (binanceSymbols.has(binance)) return [binance];

  const stripped = raw.replace(/\bOTC\b/g, '').replace(/_OTC$/g, '').replace(/[\s\/:\-]+/g, '').replace(/[^A-Z0-9]/g, '');
  if (!stripped) return [];
  return [`${stripped}_otc`];
}
function validateCandles(candles) {
  return Array.isArray(candles) && candles.length > 0 && candles.every(c => c && typeof c.close === 'number' && typeof c.time === 'number' && Number.isFinite(c.close));
}

app.post('/api/ingest-ticks', (req, res) => {
  const { ticks } = req.body || {};
  if (!Array.isArray(ticks)) return res.status(400).json({ ok: false, error: 'ticks must be an array' });
  let count = 0;
  // Sort each incoming batch chronologically first. A batch can already
  // contain ticks out of order (queued client-side over a 2s window,
  // multiple devices posting concurrently), and feeding them to
  // ingestTick() in the wrong order defeats its own oldest-first guard
  // for ticks that are merely out of order WITHIN this one batch.
  const sorted = ticks.slice().sort((a, b) => (a?.t || 0) - (b?.t || 0));
  for (const t of sorted) {
    if (t && typeof t.symbol === 'string' && typeof t.t === 'number' && typeof t.price === 'number') {
      tickStore.ingestTick(t.symbol, t.t, t.price); count++;
    }
  }
  res.json({ ok: true, ingested: count, serverTime: Date.now() });
});

app.get('/api/candles', (req, res) => {
  const { asset, timeframe } = req.query;
  if (!asset || !timeframe) return res.status(400).json({ error: 'asset and timeframe query params required' });
  const symbols = guessBrokerSymbols(asset);
  for (const sym of symbols) {
    const candles = tickStore.getCandles(sym, timeframe);
    if (candles) return res.json({ symbol: sym, count: candles.length, candles, serverTime: Date.now() });
  }
  res.json({ symbol: symbols[0], count: 0, candles: [], serverTime: Date.now() });
});

app.get('/api/strategy-config', (_req, res) => res.json({ minVotes: strategyConfig.minVotes, minMajority: strategyConfig.minMajority, enabledStrategies: strategyConfig.enabledStrategies }));

app.post('/api/calculate-signal', async (req, res) => {
  try {
    const { pair, timeframe, licenseKey, candles: clientCandles, higherTfCandles: clientHtfCandles, extendedExpiry } = req.body || {};
    if (REQUIRE_LICENSE) {
      const lic = await licenseStore.validateLicense(licenseKey, req.headers['x-device-id'] || '');
      if (!lic.valid) return res.status(403).json({ status: 'LICENSE_REQUIRED', decision: 'WAIT', license: lic });
    }
    if (!pair || typeof pair !== 'string') return res.status(400).json({ status: 'INVALID_ASSET', decision: 'WAIT' });
    if (!timeframe || typeof timeframe !== 'string') return res.status(400).json({ status: 'INVALID_TIMEFRAME', decision: 'WAIT' });

    // The ALFA spec engine's master trend filter is EMA200-based, so it
    // needs 210+ candles of real history - more than the old confluence
    // engine's 60-candle floor. Same mismatch bug pattern as before:
    // server would silently reject perfectly "ready" candle sets the
    // new engine actually needs more of.
    const MIN_CANDLES = 210;

    // Prefer centralized server candles, but fall back to the fresh candles
    // already present in the user's browser. The previous version ignored
    // clientCandles completely, which could produce repeated WAIT/DATA_UNAVAILABLE
    // while the broker chart itself was already streaming normally.
    let candles = null;
    for (const sym of guessBrokerSymbols(pair)) {
      const serverCandles = tickStore.getCandles(sym, timeframe);
      if (validateCandles(serverCandles) && serverCandles.length >= MIN_CANDLES) { candles = serverCandles; break; }
    }

    const tfSeconds = tickStore.TIMEFRAME_SECONDS[timeframe] || 60;
    const staleLimitMs = Math.max(2 * tfSeconds * 1000, 10 * 60 * 1000);
    const clientValid = validateCandles(clientCandles) && clientCandles.length >= MIN_CANDLES;
    const clientAge = clientValid ? Date.now() - clientCandles[clientCandles.length - 1].time : Infinity;
    const clientFresh = clientValid && clientAge <= staleLimitMs;

    // If the server copy is missing/short/stale, use the selected asset's
    // fresh browser candles instead of returning WAIT just because the
    // centralized store has not caught up yet.
    if (!candles || (candles.length && Date.now() - candles[candles.length - 1].time > staleLimitMs)) {
      if (clientFresh) candles = clientCandles;
    }

    if (!validateCandles(candles) || candles.length < MIN_CANDLES) {
      return res.json({ status: 'DATA_UNAVAILABLE', decision: 'WAIT', serverTime: Date.now() });
    }

    const lastCandleTime = candles[candles.length - 1].time;
    const ageMs = Date.now() - lastCandleTime;
    if (ageMs > staleLimitMs) return res.json({ status: 'STALE_DATA', decision: 'WAIT', serverTime: Date.now(), candleTime: lastCandleTime });

    // Multi-timeframe confirmation: look up the next-higher timeframe's
    // candles from the same centralized store first (most reliable,
    // shared across every device watching this asset); fall back to
    // whatever the client sent if the server doesn't have enough yet.
    // Missing entirely is fine - evaluateSignal treats it as "MTF
    // unavailable" (loses 5 confirmation points, not a hard block).
    const higherTf = HIGHER_TIMEFRAME[timeframe];
    let higherTfCandles = null;
    if (higherTf) {
      for (const sym of guessBrokerSymbols(pair)) {
        const htf = tickStore.getCandles(sym, higherTf);
        if (validateCandles(htf) && htf.length >= MIN_CANDLES) { higherTfCandles = htf; break; }
      }
      if (!higherTfCandles && Array.isArray(clientHtfCandles) && validateCandles(clientHtfCandles) && clientHtfCandles.length >= MIN_CANDLES) {
        higherTfCandles = clientHtfCandles;
      }
    }

    const result = evaluateSignal(candles, { ...strategyConfig, higherTfCandles, timeframe, extendedExpiry: !!extendedExpiry });
    res.json({ ...result, serverTime: Date.now(), candleTime: lastCandleTime });
  } catch (e) { res.status(500).json({ status: 'ERROR', decision: 'WAIT', error: e.message }); }
});

app.get('/health', async (_req, res) => {
  res.json({ ok: true, service: 'alfa-strategy-backend', serverTime: Date.now(), licenseMode: REQUIRE_LICENSE ? 'required' : 'optional', tickStoreMode: tickStore.getMode() });
});

(async () => {
  try {
    const store = await licenseStore.initStore();
    console.log(`License store: ${store.mode}`);
    if (!ADMIN_PASSWORD || !SESSION_SECRET) console.warn('ADMIN_PASSWORD and SESSION_SECRET must be set in Render environment variables.');
    app.listen(PORT, HOST, () => console.log(`ALFA Strategy backend listening on ${HOST}:${PORT}`));
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
})();
