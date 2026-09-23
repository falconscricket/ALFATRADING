# ALFA Strategy — Central Backend

The backend is the single source of truth for candles, indicators, vote counting and CALL/PUT/WAIT decisions.

## Endpoints
- `GET /health` — deployment health check.
- `POST /api/ingest-ticks` — accepts `{ ticks: [{ symbol, t, price }] }`.
- `GET /api/candles?asset=EURUSD_otc&timeframe=1m` — closed server candles.
- `GET /api/strategy-config` — current vote configuration.
- `POST /api/calculate-signal` — calculates only from server-side candles.

## Railway
- The server binds to `0.0.0.0` and uses `process.env.PORT`.
- Connect the `server` directory (or repository containing it) to Railway.
- Set `DATA_DIR` to a persistent volume mount if you need candle snapshots to survive redeploys.
- For multiple backend instances, use shared Redis/state before scaling horizontally; otherwise each instance has its own in-memory tick store.

## Important real-time behavior
A device can contribute ticks to the central store. Once a tick reaches the backend, the server builds the candle and calculates the same signal for every client using that shared history. Network latency can still exist; this does not promise zero milliseconds.
