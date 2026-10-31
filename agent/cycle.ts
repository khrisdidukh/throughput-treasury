// The business's autonomous weekly cycle, with no human in the loop:
// 1. pull a fresh 12-month flow from the live Jira, 2. keep it on-chain, 3. commit a new engine snapshot,
// 4. let the private CFO review every open offer, and the contract decide and pay, 5. record the cycle on-chain.
import { commitSnapshot, reviewOffer } from './cfo.js';
import { fetchLiveFlow } from './jira-live.js';
import { acct, call, view } from './near.js';

export const CYCLE_EVERY_MS = 7 * 86_400_000;

export async function lastCycle(): Promise<any | null> {
  try { const b = await view('get_blob', { key: 'cycle' }); return b ? JSON.parse(b) : null; } catch { return null; }
}

export async function runCycle(log: (s: string) => void = console.log) {
  const started = new Date().toISOString();
  log('pulling a fresh flow from the live Jira…');
  const live = await fetchLiveFlow('CASSANDRA', 52, () => {});
  log(`${live.issues} issues, ${live.source}`);
  await call(acct('owner'), 'store_blob', { key: 'flow', value: JSON.stringify(live) });
  const snap = await commitSnapshot('autonomous weekly cycle: ');
  log(`snapshot ${snap.sha256.slice(0, 12)}…, constraint at ${snap.constraint}`);
  const offers: any[] = (await view('get_offers')).filter((o: any) => o.active);
  const reviewed: any[] = [];
  for (const o of offers) {
    try {
      const d = await reviewOffer(o.id);
      reviewed.push({ offer: o.id, outcome: d.outcome });
      log(`${o.id}: ${d.outcome}`);
    } catch (e: any) {
      reviewed.push({ offer: o.id, outcome: 'ERROR', error: String(e?.message || e).slice(0, 160) });
      log(`${o.id}: error ${e?.message || e}`);
    }
  }
  const record = { started, finished: new Date().toISOString(), data: live.source, issues: live.issues, constraint: snap.constraint, snapshot_sha256: snap.sha256, reviewed };
  await call(acct('owner'), 'store_blob', { key: 'cycle', value: JSON.stringify(record) });
  return record;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await runCycle());
