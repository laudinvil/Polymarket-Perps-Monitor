# Cloudflare Worker deployment

This directory is deploy-ready. No Cloudflare resource IDs, namespace IDs, tokens, chat IDs, or other account-specific values need to be edited into repository files.

## Architecture

- Cloudflare Cron Trigger invokes the Worker every minute.
- A SQLite-backed Durable Object named `MonitorState` serializes executions and persists processed 5-minute buckets.
- MarginPad liquidation data is fetched for BTC, ETH, SOL, XRP, DOGE, BNB and HYPE.
- The just-closed 5-minute UTC bucket is processed.
- Telegram is marked processed only after Telegram confirms delivery.
- Failed sends are retried by a later invocation.
- `/health` exposes the last persisted result.
- `POST /run` executes the same production processing path for diagnostics.

## Files

- `worker.js` — production Worker and Durable Object.
- `wrangler.jsonc` — complete Worker, cron, Durable Object binding, and SQLite migration configuration.
- `package.json` — deterministic Wrangler commands.

There are no `REPLACE_WITH_*` placeholders and no resource IDs to paste into source control.

## Deployment

For Cloudflare Workers Builds, connect this repository and use `cloudflare` as the root directory. The deploy command is:

```bash
npm run deploy
```

The project configuration is already in `wrangler.jsonc`, so deployment does not require editing files in Cloudflare or GitHub.

The only account-scoped runtime values are the encrypted Worker secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. They must exist in the Cloudflare Worker environment, but they are never stored in repository files.

## Security

Do not commit Telegram bot tokens, chat IDs, Cloudflare API tokens, account credentials, or generated secret files. Runtime secrets belong in Cloudflare encrypted bindings.
