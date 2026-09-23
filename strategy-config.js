/** ALFA STRATEGY - QX BROKER MULTI-TIMEFRAME PRO ENGINE (v5.4.1 spec).
 * EMA 9/21/200 master trend filter + RSI 14 + Bollinger 20/2 + ADX 14 +
 * S/R + candle structure. Weighted 100/100: Trend 25 / EMA Momentum 15 /
 * RSI 15 / Bollinger 15 / Price Action 15 / ADX 10 / S-R 5.
 * Minimum score and ADX floor are now per-timeframe, not a single
 * global number - see ALFA_TIMEFRAME_RULES in server/indicators.js:
 *   1M  min 85, ADX >= 20
 *   3M  min 87, ADX >= 22
 *   5M  min 90, ADX >= 23
 *   5M+ min 92, ADX >= 25
 * This file only carries settings evaluateSignal() doesn't derive from
 * the timeframe itself. */
module.exports = {
  mode: "ALFA_SPEC_V5_4_1",
  enabledStrategies: {
    "ALFA Spec": true
  }
};
