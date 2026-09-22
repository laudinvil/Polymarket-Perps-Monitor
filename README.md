# BTC 5M Open Interest Monitor

BTC-only Polymarket 5-minute OI monitor.

At 4:45 of each Polymarket 5-minute period it reads total market Open Interest, compares it with the previous period's 4:45 snapshot, and sends one Telegram alert with MORE ↑ / LESS ↓ / SAME → plus the next BTC 5M market link.

Required GitHub Actions secrets: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.