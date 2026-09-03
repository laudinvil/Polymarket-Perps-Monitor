# Cloudflare Worker deployment

This Worker is the long-running replacement for the 5-minute GitHub Actions monitor.

## What it does

- Runs every minute with a Cloudflare Cron Trigger.
- Reads MarginPad liquidation data for BTC, ETH, SOL, XRP, DOGE, BNB and HYPE.
- Processes the just-closed 5-minute UTC bucket.
- Sends at most one alert per bucket.
- Stores the last processed bucket in Workers KV.
- Retries a failed Telegram send automatically on the next scheduled invocation because the bucket is saved only after Telegram confirms success.
- Exposes `/health` and a protected-by-intent `/run` POST endpoint for diagnostics.

## Deploy

From the `cloudflare` directory:

```bash
npx wrangler deploy
```

Wrangler can automatically provision the KV resource when the binding has no ID. The resulting KV ID is managed by Wrangler/Cloudflare; do not commit credentials to Git.

Set encrypted secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

Then deploy again if needed:

```bash
npx wrangler deploy
```

Cloudflare Cron Triggers use UTC. The configured `* * * * *` schedule runs once per minute.

## GitHub Actions deployment (optional)

A GitHub Actions deploy workflow can run Wrangler with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. The API token should be scoped to the minimum Workers/KV permissions required for this Worker.

## Security

Do not put Telegram bot tokens, chat IDs, Cloudflare API tokens, or account credentials in source files. Cloudflare Worker secrets are encrypted bindings.
