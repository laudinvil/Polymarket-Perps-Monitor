# Polymarket Perps Monitor

The project contains separate monitoring strategies for MarginPad and Polymarket.

## MarginPad strategies

- liquidation leader monitoring;
- separate LONG / SHORT direction-leader monitoring for 5-minute and 15-minute periods.

The LONG / SHORT strategy uses only MarginPad events whose `side` explicitly identifies `long` or `short`. It does not mix those events with `buy` / `sell`.

Alerts are sent to Telegram and include the corresponding live Polymarket Up/Down market link when available.
