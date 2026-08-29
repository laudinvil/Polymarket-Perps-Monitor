import { createPublicClient } from '@polymarket/client';

const client = createPublicClient();

async function main() {
  console.log('Polymarket Perps monitor: OLD ALERT LOGIC DISABLED');
  console.log('Order Book, Imbalance, BID/ASK dominance and Large Order alerts are disabled.');
  console.log('Telegram alerts are disabled until the new liquidation-based logic is installed.');
  // Intentionally do not subscribe to perps.book or generate any alerts.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
