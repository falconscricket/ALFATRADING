/**
 * indicators.js
 * -----------------------------------------------------------------------
 * Standard, publicly-documented technical analysis methods only.
 * Every number/pattern this file produces is shown to the user with the
 * reasoning behind it - nothing hidden, no invented confidence score,
 * and no method here claims a guaranteed outcome.
 *
 * Works in both the browser (extension) and Node (backend server) since
 * it has no external dependencies.
 * -----------------------------------------------------------------------
 * candles format expected everywhere below:
 *   [{ time, open, high, low, close }, ...]  oldest -> newest
 */

function closes(candles) {
  return candles.map((c) => c.close);
}

// Simple Moving Average
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// Exponential Moving Average (returns full array aligned to input)
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prevEma = sma(values.slice(0, period), period);
  out[period - 1] = prevEma;
  for (let i = period; i < values.length; i++) {
    prevEma = values[i] * k + prevEma * (1 - k);
    out[i] = prevEma;
  }
  return out;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

// RSI (Wilder's smoothing, standard 14-period default)
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD (12, 26, 9 standard settings)
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (values.length < slow + signalPeriod) return null;

  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);

  const macdLine = [];
  for (let i = 0; i < values.length; i++) {
    if (fastSeries[i] !== undefined && slowSeries[i] !== undefined) {
      macdLine[i] = fastSeries[i] - slowSeries[i];
    }
  }

  const macdValues = macdLine.filter((v) => v !== undefined);
  const signalSeries = emaSeries(macdValues, signalPeriod);
  const signalLine = signalSeries[signalSeries.length - 1];
  const macdVal = macdValues[macdValues.length - 1];
  const prevMacdVal = macdValues[macdValues.length - 2];
  const prevSignalSeries = signalSeries[signalSeries.length - 2];

  return {
    macd: macdVal,
    signal: signalLine,
    histogram: macdVal - signalLine,
    prevMacd: prevMacdVal,
    prevSignal: prevSignalSeries,
  };
}

// Bollinger Bands (20-period, 2 standard deviations - standard defaults)
function bollingerBands(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + mult * stdDev,
    middle: mean,
    lower: mean - mult * stdDev,
  };
}

// ---------------------------------------------------------------------
// Trend Following: EMA 20 vs EMA 50
// ---------------------------------------------------------------------
function trendFollowing(values) {
  const ema20 = ema(values, 20);
  const ema50 = ema(values, 50);
  if (ema20 === null || ema50 === null) return null;
  const bias = ema20 > ema50 ? "bullish" : ema20 < ema50 ? "bearish" : null;
  return { ema20, ema50, bias };
}

// ---------------------------------------------------------------------
// Support & Resistance: find recent swing highs/lows (simple pivot
// method) and check whether price is currently sitting near one.
// ---------------------------------------------------------------------
function findPivots(candles, wing = 3) {
  const highs = [];
  const lows = [];
  for (let i = wing; i < candles.length - wing; i++) {
    const windowSlice = candles.slice(i - wing, i + wing + 1);
    const isHigh = windowSlice.every((c) => candles[i].high >= c.high);
    const isLow = windowSlice.every((c) => candles[i].low <= c.low);
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

function supportResistance(candles, lookback = 40, wing = 3, proximityPct = 0.05) {
  if (candles.length < lookback) return null;
  const recent = candles.slice(candles.length - lookback);
  const { highs, lows } = findPivots(recent, wing);
  const lastClose = recent[recent.length - 1].close;
  if (highs.length === 0 && lows.length === 0) return null;

  const nearestResistance = highs.length
    ? highs.reduce((a, b) => (Math.abs(b - lastClose) < Math.abs(a - lastClose) ? b : a))
    : null;
  const nearestSupport = lows.length
    ? lows.reduce((a, b) => (Math.abs(b - lastClose) < Math.abs(a - lastClose) ? b : a))
    : null;

  const pctDiffResistance =
    nearestResistance !== null ? (Math.abs(nearestResistance - lastClose) / lastClose) * 100 : null;
  const pctDiffSupport =
    nearestSupport !== null ? (Math.abs(nearestSupport - lastClose) / lastClose) * 100 : null;

  let bias = null;
  let level = null;
  let zone = null;

  if (pctDiffSupport !== null && pctDiffSupport <= proximityPct &&
      (pctDiffResistance === null || pctDiffSupport <= pctDiffResistance)) {
    bias = "bullish"; // price sitting near support -> possible bounce up
    level = nearestSupport;
    zone = "support";
  } else if (pctDiffResistance !== null && pctDiffResistance <= proximityPct) {
    bias = "bearish"; // price sitting near resistance -> possible rejection down
    level = nearestResistance;
    zone = "resistance";
  }

  return { nearestSupport, nearestResistance, bias, level, zone };
}

// ---------------------------------------------------------------------
// Candlestick patterns: engulfing, doji, hammer, shooting star
// (last 2 candles only - standard textbook definitions)
// ---------------------------------------------------------------------
function detectCandlestickPattern(candles) {
  if (candles.length < 3) return null;
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];

  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  const currRange = curr.high - curr.low;
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;

  // Bullish engulfing
  if (
    prev.close < prev.open &&
    curr.close > curr.open &&
    curr.close >= prev.open &&
    curr.open <= prev.close
  ) {
    return { pattern: "Bullish Engulfing", bias: "bullish" };
  }

  // Bearish engulfing
  if (
    prev.close > prev.open &&
    curr.close < curr.open &&
    curr.open >= prev.close &&
    curr.close <= prev.open
  ) {
    return { pattern: "Bearish Engulfing", bias: "bearish" };
  }

  // Doji - body is a tiny fraction of the full range -> indecision, no bias
  if (currRange > 0 && currBody / currRange < 0.1) {
    return { pattern: "Doji", bias: null };
  }

  // Hammer - small body near the top, long lower wick, little/no upper wick
  if (
    currRange > 0 &&
    lowerWick > currBody * 2 &&
    upperWick < currBody &&
    curr.close < candles[candles.length - 3].close // came after a decline
  ) {
    return { pattern: "Hammer", bias: "bullish" };
  }

  // Shooting star - small body near the bottom, long upper wick
  if (
    currRange > 0 &&
    upperWick > currBody * 2 &&
    lowerWick < currBody &&
    curr.close > candles[candles.length - 3].close // came after a rise
  ) {
    return { pattern: "Shooting Star", bias: "bearish" };
  }

  return { pattern: "None", bias: null };
}

// ---------------------------------------------------------------------
// Pin Bar / Price Action - pure wick-vs-body rejection read, no indicator
// ---------------------------------------------------------------------
function pinBarSignal(candles) {
  if (candles.length < 1) return null;
  const curr = candles[candles.length - 1];
  const body = Math.abs(curr.close - curr.open);
  const range = curr.high - curr.low;
  if (range === 0) return null;
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;

  if (lowerWick >= range * 0.6 && body <= range * 0.3) {
    return { pattern: "Bullish Pin Bar", bias: "bullish" };
  }
  if (upperWick >= range * 0.6 && body <= range * 0.3) {
    return { pattern: "Bearish Pin Bar", bias: "bearish" };
  }
  return { pattern: "No pin bar", bias: null };
}

// ---------------------------------------------------------------------
// Volatility spike (simplified ATR) - informational only, used to flag
// a possible Straddle setup. Straddle means betting BOTH directions, so
// it deliberately does NOT get folded into the CALL/PUT vote below.
// ---------------------------------------------------------------------
function volatilitySpike(candles, period = 14, spikeMultiple = 1.6) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    trueRanges.push(tr);
  }
  const recentTR = trueRanges.slice(-period);
  const atr = recentTR.reduce((a, b) => a + b, 0) / period;
  const lastTR = trueRanges[trueRanges.length - 1];
  const isSpike = atr > 0 && lastTR > atr * spikeMultiple;
  // "Extremely low volatility" - the last candle's range is a small
  // fraction of its own recent average, i.e. essentially no movement to
  // trade. Relative to the asset's own ATR rather than an absolute pip
  // count, so it works the same whether the asset trades in whole
  // numbers or fractions of a cent.
  const isTooLow = atr > 0 && lastTR < atr * 0.35;
  return { atr, lastTR, isSpike, isTooLow };
}

/**
 * Combine every method above into a transparent, rule-based bias.
 * Every signal that fired is listed in `reasons` with its real value -
 * no hidden weighting, no fabricated confidence score. Straddle is
 * reported separately as an advisory, since it is a both-directions
 * approach and can't honestly be folded into a single CALL/PUT vote.
 */

// ---------------------------------------------------------------------
// Additional confluence methods: Stochastic, CCI, Momentum, ADX and
// simple breakout/retest. These are transparent confirmation methods;
// none claims to predict the next candle with certainty.
// ---------------------------------------------------------------------
function stochastic(candles, kPeriod = 14, smooth = 3) {
  if (candles.length < kPeriod + smooth - 1) return null;
  const ks = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const win = candles.slice(i - kPeriod + 1, i + 1);
    const hi = Math.max(...win.map(c => c.high));
    const lo = Math.min(...win.map(c => c.low));
    const range = hi - lo;
    ks.push(range === 0 ? 50 : ((candles[i].close - lo) / range) * 100);
  }
  const k = ks[ks.length - 1];
  const d = ks.slice(-smooth).reduce((a,b)=>a+b,0) / Math.min(smooth, ks.length);
  const prevK = ks.length > 1 ? ks[ks.length - 2] : k;
  return { k, d, prevK };
}

function cci(candles, period = 20) {
  if (candles.length < period) return null;
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  const slice = tp.slice(-period);
  const mean = slice.reduce((a,b)=>a+b,0) / period;
  const md = slice.reduce((a,b)=>a+Math.abs(b-mean),0) / period;
  if (md === 0) return { value: 0 };
  return { value: (tp[tp.length-1] - mean) / (0.015 * md) };
}

function momentum(values, period = 10) {
  if (values.length <= period) return null;
  const last = values[values.length - 1];
  const prev = values[values.length - 1 - period];
  return { value: last - prev, bullish: last > prev, bearish: last < prev };
}

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const trs = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
  }
  let atr = trs.slice(0, period).reduce((a,b)=>a+b,0) / period;
  let pDM = plusDM.slice(0, period).reduce((a,b)=>a+b,0) / period;
  let mDM = minusDM.slice(0, period).reduce((a,b)=>a+b,0) / period;
  const dx = [];
  // Track the final smoothed +DI/-DI (not just the last single candle's
  // raw DM) so bullish/bearish reflects the ADX strategy's own +DI vs
  // -DI comparison, matching "use +DI/-DI to confirm direction."
  let pdi = atr ? 100*pDM/atr : 0, mdi = atr ? 100*mDM/atr : 0;
  for (let i=period; i<trs.length; i++) {
    atr = (atr*(period-1)+trs[i]) / period;
    pDM = (pDM*(period-1)+plusDM[i]) / period;
    mDM = (mDM*(period-1)+minusDM[i]) / period;
    pdi = atr ? 100*pDM/atr : 0;
    mdi = atr ? 100*mDM/atr : 0;
    const sum = pdi+mdi;
    dx.push(sum ? 100*Math.abs(pdi-mdi)/sum : 0);
  }
  if (dx.length < period) return null;
  let value = dx.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i=period; i<dx.length; i++) value = (value*(period-1)+dx[i])/period;
  return { value, pdi, mdi, bullish: pdi > mdi, bearish: mdi > pdi, atr };
}

function breakout(candles, lookback = 20) {
  if (candles.length < lookback + 1) return null;
  const prior = candles.slice(-lookback - 1, -1);
  const last = candles[candles.length - 1];
  const high = Math.max(...prior.map(c=>c.high));
  const low = Math.min(...prior.map(c=>c.low));
  if (last.close > high) return { bias: 'bullish', level: high, type: 'upside breakout' };
  if (last.close < low) return { bias: 'bearish', level: low, type: 'downside breakout' };
  return { bias: null, level: null, type: 'inside range' };
}

// ---------------------------------------------------------------------
// ALFA CONFLUENCE STRATEGY - additional building blocks
// Price action + market structure is the primary signal; everything
// else here is confirmation only, per the spec.
// ---------------------------------------------------------------------

// Breakout + retest: not just "did price break the range" but "did it
// break out, pull back to the broken level, and close back in the
// breakout direction" - a much higher-quality entry than a bare breakout.
function breakoutRetest(candles, lookback = 20, retestBars = 6) {
  const b = breakout(candles, lookback);
  if (!b || !b.bias || b.level == null) return { bias: null, retested: false, level: null };
  const recent = candles.slice(-retestBars - 1, -1);
  if (!recent.length) return { bias: b.bias, retested: false, level: b.level };
  const tol = Math.abs(b.level) * 0.0015; // ~0.15% tolerance band around the level
  const touchedLevel = recent.some(c => c.low - tol <= b.level && c.high + tol >= b.level);
  const lastC = candles[candles.length - 1];
  const confirmedBack = b.bias === "bullish" ? lastC.close > b.level : lastC.close < b.level;
  return { bias: b.bias, retested: touchedLevel && confirmedBack, level: b.level };
}

// Swing-high/low pivot sequence with index, kept in chronological order -
// findPivots() above only returns bare price values, which isn't enough
// to tell whether the sequence is making higher-highs/higher-lows
// (bullish structure) or lower-highs/lower-lows (bearish structure).
function findPivotsIndexed(candles, wing = 3) {
  const highs = [], lows = [];
  for (let i = wing; i < candles.length - wing; i++) {
    const windowSlice = candles.slice(i - wing, i + wing + 1);
    const isHigh = windowSlice.every((c) => candles[i].high >= c.high);
    const isLow = windowSlice.every((c) => candles[i].low <= c.low);
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

// Market structure: bullish = higher-high + higher-low on the last two
// swings; bearish = lower-high + lower-low; anything else is "unclear"
// (spec: "Avoid signals when structure is unclear"). BOS = the latest
// closed candle breaking beyond the most recent opposite-context swing
// point - a genuine break of the structure that was holding until now.
function marketStructure(candles, lookback = 80, wing = 3) {
  const effLookback = Math.min(lookback, candles.length);
  if (effLookback < wing * 2 + 12) return null;
  const recent = candles.slice(candles.length - effLookback);
  const { highs, lows } = findPivotsIndexed(recent, wing);

  if (highs.length < 2 || lows.length < 2) {
    // Fallback for a smooth/strong trend that never formed two clean
    // wing=3 pivots on each side (a real possibility, not just a test
    // artifact - a steady trend can run a long way without a sharp
    // enough pullback to register as a pivot). Falling back to
    // "unclear" here would silently reintroduce the exact bug this
    // whole build has been fixing: a real trend read as no-trend and
    // permanently held at WAIT. Compare the first half of the window
    // against the second half instead - cruder, but it still correctly
    // tells a genuine trend apart from a flat/choppy range.
    const half = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, half);
    const secondHalf = recent.slice(half);
    const fhHigh = Math.max(...firstHalf.map(c => c.high));
    const fhLow = Math.min(...firstHalf.map(c => c.low));
    const shHigh = Math.max(...secondHalf.map(c => c.high));
    const shLow = Math.min(...secondHalf.map(c => c.low));
    let trend = "unclear";
    if (shHigh > fhHigh && shLow > fhLow) trend = "bullish";
    else if (shHigh < fhHigh && shLow < fhLow) trend = "bearish";
    const lastClose = recent[recent.length - 1].close;
    let bos = null;
    if (lastClose > fhHigh) bos = "bullish";
    else if (lastClose < fhLow) bos = "bearish";
    return { trend, bos, lastSwingHigh: fhHigh, lastSwingLow: fhLow, fallback: true };
  }

  const [prevHigh, lastHigh] = highs.slice(-2);
  const [prevLow, lastLow] = lows.slice(-2);
  let trend = "unclear";
  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) trend = "bullish";
  else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) trend = "bearish";

  const lastClose = recent[recent.length - 1].close;
  let bos = null;
  if (lastClose > lastHigh.price) bos = "bullish";
  else if (lastClose < lastLow.price) bos = "bearish";

  return { trend, bos, lastSwingHigh: lastHigh.price, lastSwingLow: lastLow.price, fallback: false };
}

// EMA 9/21/50/200 trend filter. "Tangled" (spec's own word) = the three
// core EMAs are not in a clean bullish or bearish order - WAIT regardless
// of everything else. EMA200 is treated as a soft long-term confirmation
// bonus (only when there's enough history for it), never a hard gate,
// since 200 candles of continuous data won't always be available.
function emaAlignment(values) {
  const e9 = ema(values, 9);
  const e21 = ema(values, 21);
  const e50v = ema(values, 50);
  const e200 = values.length >= 210 ? ema(values, 200) : null;
  if (e9 == null || e21 == null || e50v == null) return null;
  const last = values[values.length - 1];
  const bullishOrder = e9 > e21 && e21 > e50v;
  const bearishOrder = e9 < e21 && e21 < e50v;
  return {
    e9, e21, e50: e50v, e200,
    bullishOrder, bearishOrder, tangled: !bullishOrder && !bearishOrder,
    priceAboveE50: last > e50v, priceBelowE50: last < e50v,
    longTermBullish: e200 != null ? e50v > e200 : null,
    longTermBearish: e200 != null ? e50v < e200 : null,
  };
}

// RSI as confirmation only (never the "RSI 70 = PUT" trap the spec
// explicitly warns against) - side of 50, plus whether it's actually
// moving in that direction over the last few candles, not just resting
// on one side of the midline.
function rsiMomentum(values, period = 14, lookback = 3) {
  const value = rsi(values, period);
  if (value == null || values.length < period + lookback + 5) return { value, rising: null, falling: null };
  const prior = rsi(values.slice(0, values.length - lookback), period);
  return { value, rising: prior != null ? value > prior : null, falling: prior != null ? value < prior : null };
}

// Candle confirmation: engulfing or a rejection pin bar, AND the candle
// must actually close in that direction - "never enter before candle
// confirmation" per the spec. Reuses the existing pattern detectors.
function candleConfirmation(candles) {
  const pattern = detectCandlestickPattern(candles);
  const pin = pinBarSignal(candles);
  const lastC = candles[candles.length - 1];
  return {
    engulfBias: pattern?.bias || null, pattern: pattern?.pattern || null,
    pinBias: pin?.bias || null, pinPattern: pin?.pattern || null,
    closedBullish: lastC.close > lastC.open, closedBearish: lastC.close < lastC.open,
  };
}

// =====================================================================
// ALFA STRATEGY ENGINE - v6.0 "SPEC" REPLACEMENT
// Implements the ALFA STRATEGY - QX BROKER MULTI-TIMEFRAME PRO ENGINE
// document exactly: EMA 9/21/200 master trend filter, RSI 14, Bollinger
// 20/2, ADX 14, S/R, candle structure. One unified engine, four
// timeframe presets (1M/3M/5M/5M+) with their own minimum score + ADX
// floor. Confidence score is NEVER shown/claimed as a guaranteed win
// probability - only ever the raw 0-100 confluence total.
// =====================================================================
const ALFA_TIMEFRAME_RULES = {
  "1m":  { label: "1M",  expiry: "1-2 MIN",  minScore: 85, minAdx: 20 },
  "3m":  { label: "3M",  expiry: "3 MIN",    minScore: 87, minAdx: 22 },
  "5m":  { label: "5M",  expiry: "5 MIN",    minScore: 90, minAdx: 23 },
  "5m+": { label: "5M+", expiry: "5-15 MIN", minScore: 92, minAdx: 25 },
};

function resolveAlfaTimeframe(timeframe, extendedExpiry) {
  if (timeframe === "5m" && extendedExpiry) return ALFA_TIMEFRAME_RULES["5m+"];
  return ALFA_TIMEFRAME_RULES[timeframe] || ALFA_TIMEFRAME_RULES["5m"];
}

function evaluateSignal(candles, options = {}) {
  const values = closes(candles);
  const last = values[values.length - 1];
  const tfKey = options.timeframe || "5m";
  const rules = resolveAlfaTimeframe(tfKey, options.extendedExpiry);

  // Master long-term trend filter uses a 50-period EMA (TREND_EMA_PERIOD
  // below). A true EMA200 needs 200+ candles just to produce its first
  // value - mathematically impossible on 80 candles - so the trend
  // filter period and the minimum-history gate must move together.
  const TREND_EMA_PERIOD = 50;
  const MIN_HISTORY_CANDLES = 80;
  if (!last || values.length < MIN_HISTORY_CANDLES) {
    return { status: "DATA_UNAVAILABLE", decision: "WAIT",
      reasons: [`Not enough candle history for the ALFA spec engine (need ${MIN_HISTORY_CANDLES}+ candles - EMA${TREND_EMA_PERIOD} trend filter is a hard requirement).`] };
  }

  const e9 = ema(values, 9);
  const e21 = ema(values, 21);
  const e50Trend = ema(values, TREND_EMA_PERIOD);
  const r = rsi(values, 14);
  const bb = bollingerBands(values, 20, 2);
  const ad = adx(candles, 14);
  const srInfo = supportResistance(candles, Math.min(40, candles.length), 3, 0.05);
  const candle = candleConfirmation(candles);
  const pattern = detectCandlestickPattern(candles);
  const pin = pinBarSignal(candles);

  if (e9 == null || e21 == null || e50Trend == null || r == null || !bb || !ad) {
    return { status: "DATA_UNAVAILABLE", decision: "WAIT", reasons: ["Indicators not ready yet."] };
  }

  const e9Series = emaSeries(values, 9);
  const e21Series = emaSeries(values, 21);
  const e50TrendSeries = emaSeries(values, TREND_EMA_PERIOD);

  // ---- EMA 9/21 recent-crossing check (spec: "If EMA 9/21 conflict: WAIT") ----
  let crossCount = 0;
  const checkBars = Math.min(6, values.length - 21);
  for (let i = values.length - checkBars; i < values.length; i++) {
    if (e9Series[i] == null || e21Series[i] == null || e9Series[i - 1] == null || e21Series[i - 1] == null) continue;
    const wasAbove = e9Series[i - 1] > e21Series[i - 1];
    const isAbove = e9Series[i] > e21Series[i];
    if (wasAbove !== isAbove) crossCount++;
  }
  const emaCrossing = crossCount >= 2;

  // ---- price repeatedly crossing the EMA trend line (spec: WAIT) ----
  let trendCrossCount = 0;
  const trendCheckBars = Math.min(10, values.length - TREND_EMA_PERIOD);
  for (let i = values.length - trendCheckBars; i < values.length; i++) {
    if (e50TrendSeries[i] == null || e50TrendSeries[i - 1] == null) continue;
    const wasAbove = values[i - 1] > e50TrendSeries[i - 1];
    const isAbove = values[i] > e50TrendSeries[i];
    if (wasAbove !== isAbove) trendCrossCount++;
  }
  const repeatedTrendCross = trendCrossCount >= 3;

  // ---- price near the EMA trend line without clear direction ----
  const distToTrendPct = (Math.abs(last - e50Trend) / e50Trend) * 100;
  const nearTrendUndirected = distToTrendPct < 0.05 && (Math.abs(e9 - e21) / e21) * 100 < 0.02;

  // ---- Master trend filter ----
  const bullishTrend = last > e50Trend && e9 > e21;
  const bearishTrend = last < e50Trend && e9 < e21;

  // ---- Bollinger squeeze ----
  const bbWidthPct = ((bb.upper - bb.lower) / bb.middle) * 100;
  const bbSqueeze = bbWidthPct < 0.6;

  // ---- Choppy market guard (weak ADX + frequent direction flips) ----
  const recentForChop = candles.slice(-14);
  let flips = 0;
  for (let i = 1; i < recentForChop.length; i++) {
    const prevUp = recentForChop[i - 1].close >= recentForChop[i - 1].open;
    const curUp = recentForChop[i].close >= recentForChop[i].open;
    if (prevUp !== curUp) flips++;
  }
  const flipRatio = recentForChop.length > 1 ? flips / (recentForChop.length - 1) : 0;
  const choppy = ad.value < 15 && flipRatio >= 0.65;

  const confirmationCandle = pattern?.bias || pin?.bias || null;
  const strongOppositeCandle = (side) => {
    const opp = side === "bullish" ? "bearish" : "bullish";
    return pattern?.bias === opp || pin?.bias === opp;
  };

  const scoreSide = (side) => {
    const bullish = side === "bullish";
    const parts = [];
    const fails = [];
    let disqualified = false;

    // ---- TREND (25) ----
    let trendPts = 0;
    const priceRight = bullish ? last > e50Trend : last < e50Trend;
    const emaRight = bullish ? e9 > e21 : e9 < e21;
    if (priceRight && emaRight) { trendPts = 25; parts.push(`Price ${bullish ? "above" : "below"} EMA${TREND_EMA_PERIOD} and EMA9 ${bullish ? "above" : "below"} EMA21 (+25)`); }
    else if (priceRight || emaRight) { trendPts = 10; parts.push("Partial trend alignment (+10)"); fails.push("trend only partially aligned"); }
    else { disqualified = true; fails.push(`Master trend filter against ${side}`); }

    // ---- EMA MOMENTUM (15) ----
    let emaPts = 0;
    const spreadNow = e9 - e21;
    const idxBack = Math.max(21, values.length - 6);
    const e9Back = e9Series[idxBack], e21Back = e21Series[idxBack];
    const spreadBack = e9Back != null && e21Back != null ? e9Back - e21Back : null;
    const momentumBuilding = spreadBack != null && (bullish ? spreadNow > spreadBack && spreadNow > 0 : spreadNow < spreadBack && spreadNow < 0);
    if (emaRight && momentumBuilding) { emaPts = 15; parts.push("EMA 9/21 spread widening in trend direction (+15)"); }
    else if (emaRight) { emaPts = 7; parts.push("EMA 9/21 aligned, momentum flat (+7)"); }
    else fails.push("EMA momentum not confirming");

    // ---- RSI (15) ----
    let rsiPts = 0;
    if (bullish && r > 50) {
      rsiPts = r >= 52 && r <= 68 ? 15 : 8;
      parts.push(`RSI ${r.toFixed(1)} ${rsiPts === 15 ? "in preferred 52-68 range" : "above 50"} (+${rsiPts})`);
    } else if (!bullish && r < 50) {
      rsiPts = r >= 32 && r <= 48 ? 15 : 8;
      parts.push(`RSI ${r.toFixed(1)} ${rsiPts === 15 ? "in preferred 32-48 range" : "below 50"} (+${rsiPts})`);
    } else fails.push(`RSI ${r.toFixed(1)} not on the ${side} side of 50`);

    // ---- BOLLINGER (15) ----
    let bbPts = 0;
    const towardMiddleOrBeyond = bullish ? last >= bb.middle : last <= bb.middle;
    if (bbSqueeze && !confirmationCandle) { fails.push("Bollinger squeeze without confirmation"); }
    else if (towardMiddleOrBeyond && !bbSqueeze) { bbPts = 15; parts.push(`Bollinger structure supports ${side} move (+15)`); }
    else if (towardMiddleOrBeyond) { bbPts = 7; parts.push("Bollinger leaning right side, bands tight (+7)"); }
    else fails.push("Price on wrong side of Bollinger middle");

    // ---- PRICE ACTION (15) ----
    let candlePts = 0;
    const closedRight = bullish ? candle.closedBullish : candle.closedBearish;
    if (confirmationCandle === side) { candlePts = 15; parts.push(`${pattern?.bias === side ? pattern.pattern : pin.pattern} confirms ${side} (+15)`); }
    else if (closedRight) { candlePts = 7; parts.push(`Last candle closed ${side}, no strong rejection pattern (+7)`); }
    else fails.push("No confirmation candle");
    if (strongOppositeCandle(side)) { disqualified = true; fails.push(`Strong opposite (${side === "bullish" ? "bearish" : "bullish"}) candle against the trade`); }

    // ---- ADX (10) ----
    let adxPts = 0;
    const diRight = bullish ? ad.bullish : ad.bearish;
    if (ad.value >= rules.minAdx && diRight) { adxPts = 10; parts.push(`ADX ${ad.value.toFixed(1)} >= ${rules.minAdx} with DI confirming (+10)`); }
    else if (diRight) { adxPts = 4; fails.push(`ADX ${ad.value.toFixed(1)} below required ${rules.minAdx}`); }
    else fails.push("DI not confirming direction");

    // ---- S/R (5) ----
    let srPts = 5;
    const oppositeZone = bullish ? srInfo?.zone === "resistance" : srInfo?.zone === "support";
    if (oppositeZone) { srPts = 0; disqualified = true; fails.push(`Strong ${srInfo.zone} immediately ahead, against ${side}`); }
    else parts.push("No strong opposing S/R nearby (+5)");

    const score = Math.max(0, Math.min(100, trendPts + emaPts + rsiPts + bbPts + candlePts + adxPts + srPts));
    return {
      score, parts, fails, disqualified,
      breakdown: { trend: trendPts, emaMomentum: emaPts, rsi: rsiPts, bollinger: bbPts, priceAction: candlePts, adx: adxPts, sr: srPts },
    };
  };

  const bull = scoreSide("bullish");
  const bear = scoreSide("bearish");

  // ---- Hard WAIT gates (spec's WAIT FILTER section) ----
  let vetoReason = null;
  if (r >= 45 && r <= 55) vetoReason = `RSI ${r.toFixed(1)} in the 45-55 dead zone - no directional edge.`;
  else if (emaCrossing) vetoReason = "EMA 9/21 crossing / conflicting - trend not established.";
  else if (repeatedTrendCross) vetoReason = `Price repeatedly crossing EMA${TREND_EMA_PERIOD} - no established regime.`;
  else if (nearTrendUndirected) vetoReason = `Price sitting on EMA${TREND_EMA_PERIOD} without a clear direction.`;
  else if (!bullishTrend && !bearishTrend) vetoReason = `EMA 9/21 conflicts with the master trend filter (price/EMA${TREND_EMA_PERIOD} vs EMA9/21 disagree).`;
  else if (choppy) vetoReason = `Choppy market (ADX ${ad.value.toFixed(1)}, ${Math.round(flipRatio * 100)}% of the last 14 candles flipped direction) - no clean trend to trade.`;
  else if (bbSqueeze && !confirmationCandle) vetoReason = "Bollinger squeeze with no confirmation candle yet.";
  else if (!confirmationCandle && !candle.closedBullish && !candle.closedBearish) vetoReason = "No confirmation candle.";

  let decision = "WAIT";
  if (!vetoReason) {
    const bullOk = bullishTrend && !bull.disqualified && bull.score >= rules.minScore;
    const bearOk = bearishTrend && !bear.disqualified && bear.score >= rules.minScore;
    if (bullOk && bearOk) vetoReason = "Conflicting indicators - both sides qualify, ambiguous setup.";
    else if (bullOk) decision = "CALL";
    else if (bearOk) decision = "PUT";
  }

  const activeScore = decision === "CALL" ? bull.score : decision === "PUT" ? bear.score : Math.max(bull.score, bear.score);
  let tier = null;
  if (decision !== "WAIT") tier = activeScore >= 92 ? "STRONG SETUP" : "VALID SETUP";

  const momentumLabel = ad.value >= 35 ? "STRONG" : ad.value >= rules.minAdx ? "MEDIUM" : "WEAK";
  const trendLabel = bullishTrend ? "BULLISH" : bearishTrend ? "BEARISH" : "NEUTRAL";
  const setupLabel = decision !== "WAIT" ? "VALID" : (activeScore >= 80 ? "WEAK" : "INVALID");

  return {
    status: "OK",
    decision,
    tier,
    signalValue: decision === "CALL" ? activeScore : decision === "PUT" ? -activeScore : 0,
    trendLabel,
    momentumLabel,
    setupLabel,
    confidence: activeScore,
    indicators: {
      rsi: r, ema9: e9, ema21: e21, emaTrend: e50Trend, emaTrendPeriod: TREND_EMA_PERIOD, adx: ad,
      bollinger: bb,
      supportResistance: srInfo,
      candlestickPattern: pattern,
      pinBar: pin,
      topConfluence: { callScore: bull.score, putScore: bear.score, threshold: rules.minScore, minAdx: rules.minAdx },
      lastClose: last,
    },
    reasons: decision !== "WAIT"
      ? (decision === "CALL" ? bull.parts : bear.parts)
      : [
          vetoReason || `Score below ${rules.minScore}/100 to act - CALL ${bull.score}, PUT ${bear.score}.`,
          ...(bull.fails.length ? [`CALL held back: ${bull.fails.join(", ")}`] : []),
          ...(bear.fails.length ? [`PUT held back: ${bear.fails.join(", ")}`] : []),
        ],
    agreeingSignals: decision !== "WAIT" ? (decision === "CALL" ? bull.parts.length : bear.parts.length) : 0,
    totalSignals: 7,
    strategyConfig: { minScore: rules.minScore, minAdx: rules.minAdx, mode: "ALFA_SPEC_V5_4_1", timeframeLabel: rules.label, expiry: rules.expiry },
  };
}


// Support both browser (window) and Node (module.exports)
const IndicatorLib = {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  trendFollowing,
  supportResistance,
  detectCandlestickPattern,
  pinBarSignal,
  volatilitySpike,
  stochastic,
  cci,
  momentum,
  adx,
  breakout,
  breakoutRetest,
  marketStructure,
  emaAlignment,
  rsiMomentum,
  candleConfirmation,
  evaluateSignal,
  ALFA_TIMEFRAME_RULES,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = IndicatorLib;
}
if (typeof window !== "undefined") {
  window.IndicatorLib = IndicatorLib;
}
