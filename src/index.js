import { createPublicClient } from '@polymarket/client';

const client = createPublicClient();

function topicOf(event) {
  return String(event?.topic ?? event?.type ?? '').toLowerCase();
}

function payloadOf(event) {
  return event?.payload ?? event?.data ?? event;
}

function summarize(event) {
  const p = payloadOf(event);
  const keys = Object.keys(p ?? {});
  return {
    topic: topicOf(event),
    keys,
    sample: p
  };
}

async function main() {
  console.log('PERPS DATA DIAGNOSTIC MODE');
  console.log('OLD ALERTS: DISABLED');
  console.log('Order Book / Large Order / Imbalance / Dominance: DISABLED');
  console.log('Telegram: DISABLED');
  console.log('Collecting trades and statistics payloads only.');

  const handle = await client.subscribe([
    { topic: 'perps.trades' },
    { topic: 'perps.statistics' }
  ]);

  let count = 0;
  for await (const event of handle) {
    const topic = topicOf(event);
    if (topic !== 'perps.trades' && topic !== 'perps.statistics') continue;
    count += 1;
    console.log(`[PERPS DATA ${count}] ${JSON.stringify(summarize(event))}`);
    if (count >= 50) {
      console.log('Collected 50 samples; keeping process alive without alerts.');
      await new Promise(() => {});
    }
  }
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
