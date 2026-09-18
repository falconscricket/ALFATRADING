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
  return { atr, lastTR, isSpike };
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
  for (let i=period; i<trs.length; i++) {
    atr = (atr*(period-1)+trs[i]) / period;
    pDM = (pDM*(period-1)+plusDM[i]) / period;
    mDM = (mDM*(period-1)+minusDM[i]) / period;
    const pdi = atr ? 100*pDM/atr : 0;
    const mdi = atr ? 100*mDM/atr : 0;
    const sum = pdi+mdi;
    dx.push(sum ? 100*Math.abs(pdi-mdi)/sum : 0);
  }
  if (dx.length < period) return null;
  let value = dx.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i=period; i<dx.length; i++) value = (value*(period-1)+dx[i])/period;
  const lastTR = trs[trs.length-1] || 0;
  const lastUp = plusDM[plusDM.length-1] || 0;
  const lastDown = minusDM[minusDM.length-1] || 0;
  return { value, bullish: lastUp > lastDown, bearish: lastDown > lastUp, atr };
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

function evaluateSignal(candles, options = {}) {
  const defaultConfig = require("./strategy-config");
  const cfg = {
    ...defaultConfig,
    ...options,
    enabledStrategies: {
      ...defaultConfig.enabledStrategies,
      ...(options.enabledStrategies || {}),
    },
  };
  const values = closes(candles);
  const last = values[values.length - 1];
  if (!last || values.length < 35) {
    return { status:"DATA_UNAVAILABLE", decision:"WAIT", reasons:["Not enough candle history for the top confluence strategy."] };
  }

  const r = rsi(values,14);
  const m = macd(values,12,26,9);
  const e20 = ema(values,20), e50 = ema(values,50) || ema(values,30);
  const e20s = emaSeries(values,20);
  const ad = adx(candles,14);
  const lastCandle = candles[candles.length - 1] || {};
  const range = Math.max(0, Number(lastCandle.high) - Number(lastCandle.low));
  const body = Math.abs(Number(lastCandle.close) - Number(lastCandle.open));
  const bodyRatio = range > 0 ? body / range : 0;
  const prevClose = values[values.length - 2];
  const prevE20 = e20s.length >= 2 ? e20s[e20s.length - 2] : null;

  // ONE strategy only: ALFA Top Confluence.
  // 5 quality factors, 20 points each. A top setup needs >=40/100 (2+ aligned factors).
  // This increases signal frequency while keeping the single TOP ONLY strategy.
  // This is a quality threshold, not a guaranteed live win rate.
  const scoreSide = (side) => {
    const bullish = side === "bullish";
    let score = 0;
    const reasons = [];
    const factors = [];

    // 1. Trend alignment (20)
    const trendOK = bullish ? (e20 > e50 && last >= e20) : (e20 < e50 && last <= e20);
    if (trendOK) { score += 20; factors.push("trend"); }

    // 2. Momentum alignment (20)
    const momentumOK = bullish
      ? (m && m.macd > m.signal && m.histogram > 0 && r !== null && r >= 54 && r <= 66)
      : (m && m.macd < m.signal && m.histogram < 0 && r !== null && r <= 46 && r >= 34);
    if (momentumOK) { score += 20; factors.push("momentum"); }

    // 3. Strong directional trend (20)
    const adxOK = !!(ad && ad.value >= 25 && (bullish ? ad.bullish : ad.bearish));
    if (adxOK) { score += 20; factors.push("ADX"); }

    // 4. Pullback/reclaim quality (20)
    const pullbackOK = bullish
      ? (last >= e20 && prevClose < (prevE20 == null ? e20 : prevE20))
      : (last <= e20 && prevClose > (prevE20 == null ? e20 : prevE20));
    if (pullbackOK) { score += 20; factors.push("EMA20 reclaim/rejection"); }

    // 5. Candle strength (20)
    const candleOK = bodyRatio >= 0.45 && (bullish ? lastCandle.close > lastCandle.open : lastCandle.close < lastCandle.open);
    if (candleOK) { score += 20; factors.push("candle strength"); }

    reasons.push(`${side === "bullish" ? "CALL" : "PUT"} quality score ${score}/100 (${factors.join(", ") || "no factors"})`);
    return { score, reasons, factors };
  };

  const bull = scoreSide("bullish");
  const bear = scoreSide("bearish");
  const threshold = Math.min(100, Math.max(40, Number(cfg.minScore) || 40));
  // Require at least 2 aligned factors. Prefer setups with trend/momentum
  // structure; this prevents a single isolated candle from triggering.
  const qualifies = (x) => x.score >= threshold && x.factors.length >= 2 &&
    (x.factors.includes("trend") || x.factors.includes("ADX") || x.factors.includes("momentum")) &&
    (x.factors.includes("momentum") || x.factors.includes("candle strength") || x.factors.includes("EMA20 reclaim/rejection"));

  // --- Quality veto layer (mirrors lib/indicators.js) ----------------
  const RSI_OVERBOUGHT_BLOCK = 75;
  const RSI_OVERSOLD_BLOCK = 25;
  const callBlockedByRsi = r !== null && r >= RSI_OVERBOUGHT_BLOCK;
  const putBlockedByRsi = r !== null && r <= RSI_OVERSOLD_BLOCK;

  const last4 = candles.slice(-4);
  let bullAgree4 = 0, bearAgree4 = 0;
  for (const c of last4) {
    if (Number(c.close) > Number(c.open)) bullAgree4++;
    else if (Number(c.close) < Number(c.open)) bearAgree4++;
  }
  const enoughHistoryFor4 = last4.length >= 4;
  const callBlockedByRecentTrend = enoughHistoryFor4 && bullAgree4 < 3;
  const putBlockedByRecentTrend = enoughHistoryFor4 && bearAgree4 < 3;

  const srInfo = supportResistance(candles, Math.min(40, candles.length), 3, 0.05);
  const callBlockedBySR = !!(srInfo && srInfo.zone === "resistance");
  const putBlockedBySR = !!(srInfo && srInfo.zone === "support");

  // Doji/indecision candle guard (mirrors lib/indicators.js)
  const DOJI_BODY_RATIO_MAX = 0.15;
  const lastCandleIsDoji = range > 0 && bodyRatio < DOJI_BODY_RATIO_MAX;

  let decision = "WAIT";
  let vetoReason = null;
  if (qualifies(bull) && bull.score > bear.score) {
    if (callBlockedByRsi) vetoReason = `CALL blocked: RSI ${r.toFixed(1)} is extremely overbought (>=${RSI_OVERBOUGHT_BLOCK}) - chasing an already-extended move carries elevated reversal risk. Held at WAIT even though the quality score (${bull.score}/100) qualified.`;
    else if (callBlockedByRecentTrend) vetoReason = `CALL blocked: only ${bullAgree4}/4 of the last closed candles are bullish - recent price action is too mixed/reversing to trust this entry. Held at WAIT even though the quality score (${bull.score}/100) qualified.`;
    else if (callBlockedBySR) vetoReason = `CALL blocked: price is sitting right at a recent resistance level (${srInfo.level}) - rejection risk is elevated here. Held at WAIT even though the quality score (${bull.score}/100) qualified.`;
    else if (lastCandleIsDoji) vetoReason = `CALL blocked: the last closed candle is a doji/indecision candle (body is only ${(bodyRatio*100).toFixed(0)}% of its range) - no confirmed direction yet. Held at WAIT even though the quality score (${bull.score}/100) qualified.`;
    else decision = "CALL";
  } else if (qualifies(bear) && bear.score > bull.score) {
    if (putBlockedByRsi) vetoReason = `PUT blocked: RSI ${r.toFixed(1)} is extremely oversold (<=${RSI_OVERSOLD_BLOCK}) - chasing an already-extended move carries elevated reversal risk. Held at WAIT even though the quality score (${bear.score}/100) qualified.`;
    else if (putBlockedByRecentTrend) vetoReason = `PUT blocked: only ${bearAgree4}/4 of the last closed candles are bearish - recent price action is too mixed/reversing to trust this entry. Held at WAIT even though the quality score (${bear.score}/100) qualified.`;
    else if (putBlockedBySR) vetoReason = `PUT blocked: price is sitting right at a recent support level (${srInfo.level}) - bounce risk is elevated here. Held at WAIT even though the quality score (${bear.score}/100) qualified.`;
    else if (lastCandleIsDoji) vetoReason = `PUT blocked: the last closed candle is a doji/indecision candle (body is only ${(bodyRatio*100).toFixed(0)}% of its range) - no confirmed direction yet. Held at WAIT even though the quality score (${bear.score}/100) qualified.`;
    else decision = "PUT";
  }

  const active = decision === "CALL" ? bull : decision === "PUT" ? bear : null;
  return {
    status:"OK",
    decision,
    indicators:{
      rsi:r, macd:m, ema20:e20, ema50:e50, adx:ad,
      ma10:sma(values,10), ma30:sma(values,30),
      bollinger:bollingerBands(values,20,2),
      trend:trendFollowing(values),
      supportResistance:srInfo,
      candlestickPattern:detectCandlestickPattern(candles),
      pinBar:pinBarSignal(candles),
      stochastic:stochastic(candles,14,3),
      cci:cci(candles,20),
      momentum:momentum(values,10),
      breakout:breakout(candles,20),
      lastClose:last, candleBody:body, candleRange:range, bodyRatio,
      topConfluence:{callScore:bull.score, putScore:bear.score, threshold}
    },
    reasons: active ? active.reasons : (vetoReason ? [vetoReason] : [
      `Top Confluence below ${threshold}/100 — CALL ${bull.score}, PUT ${bear.score}. WAIT.`
    ]),
    agreeingSignals: active ? Math.floor(active.score / 20) : 0,
    totalSignals: active ? 5 : 0,
    voteCount:{bullish:bull.score / 20, bearish:bear.score / 20, total:Math.max(bull.score,bear.score)/20, required:4, majorityRequired:0.80},
    strategyConfig:{minScore:threshold, mode:"TOP_ONLY", enabledStrategies:cfg.enabledStrategies}
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
  evaluateSignal,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = IndicatorLib;
}
if (typeof window !== "undefined") {
  window.IndicatorLib = IndicatorLib;
}
