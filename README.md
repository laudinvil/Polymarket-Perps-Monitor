# Polymarket Perps Composite Monitor

The project no longer sends BBO / Order Book alerts.

## Signal engine

It combines public Perps market data:

- price change over 5 minutes;
- traded volume and a rolling 5-minute baseline;
- open-interest change over 5 minutes;
- funding rate;
- a 4-factor score for `LONGS ENTERING` / `SHORTS ENTERING`.

Default signal requires at least 3 of 4 factors:

- price move: 1.5% / 5m;
- OI change: 5% / 5m;
- funding: +0.03% for long / -0.03% for short;
- volume: 3x rolling baseline.

The engine waits for at least 3 previous 5-minute volume buckets before generating signals, which avoids startup false positives.

## Next stage

Add a second layer that matches a Perps signal to a live Polymarket prediction market (for example BTC/ETH short-term Up/Down markets) and sends one combined Telegram alert with both prices and links.

The Perps API is currently experimental in the official SDK, so the implementation keeps the data parser tolerant to API field-name changes.
