// Business agent + CFO pipeline as functions (used by the CLI scripts and the demo server).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_FLOW, DEMO_SOURCE } from '../engine/cassandra-demo.js';
import { simulate, type Scenario } from '../engine/economist.js';
import { compact, fromFlow } from '../engine/report.js';
import { acct, call, view } from './near.js';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
for (const l of fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n') : []) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const API = 'https://cloud-api.near.ai/v1';
export const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const SNAPS = path.join(ROOT, 'snapshots');
const EVIDENCE = path.join(ROOT, 'evidence');

function scenarioFor(o: any): Scenario {
  if (o.lever === 'policy') return { label: o.id, lever: 'policy', status: o.stage, queueCutPct: 0.5 };
  if (o.lever === 'automate') return { label: o.id, lever: 'automate', status: o.stage, automationPct: 0.5 };
  if (o.lever === 'hire') return { label: o.id, lever: 'hire', status: o.stage, addPeople: 1, hire: 1 };
  return { label: o.id, lever: 'move', status: o.stage, addPeople: 1 };
}

/** Build the flow snapshot with the Goldratt engine, price every open offer, commit the hash on-chain. */
export async function commitSnapshot(): Promise<{ sha256: string; constraint: string }> {
  const report = fromFlow('Apache Cassandra', 'demo', DEMO_FLOW);
  const c = report.constraints[0];
  const offers: any[] = (await view('get_offers')).filter((o: any) => o.active);
  const snapshot = {
    business: 'An open-source database team run as an autonomous software business (stand-in data: public Apache Cassandra Jira history)',
    source: DEMO_SOURCE,
    engine: 'Theory of Constraints flow engine (github.com/khrisdidukh/throughput-treasury/engine), deterministic, reproducible from this snapshot',
    money_assumptions: report.money,
    flow: compact(report),
    constraint: { stage: c.status, served_by: c.servedBy, type: c.type, lead_share: Math.round(c.leadShare * 100) + '%' },
    offer_estimates: offers.map((o) => {
      const r = simulate(report.flow, c, scenarioFor(o), report.money);
      return {
        offer: o.id, stage: o.stage, lever: o.lever, price_eur_per_year: o.price_eur_per_week * 52,
        touches_constraint: r.touchesConstraint,
        delivered_per_week: `${r.throughputPerWeek.before.toFixed(1)} -> ${r.throughputPerWeek.after.toFixed(1)}`,
        mean_lead_time_days: `${Math.round(r.leadTimeDays.before)} -> ${Math.round(r.leadTimeDays.after)}`,
        real_value_per_year_eur: Math.round(r.money.realPerYear),
        paper_value_per_year_eur: Math.round(r.money.paperPerYear),
        engine_verdict: r.verdict,
      };
    }),
  };
  const text = JSON.stringify(snapshot);
  const h = sha(text);
  fs.mkdirSync(SNAPS, { recursive: true });
  fs.writeFileSync(path.join(SNAPS, `${h}.json`), text);
  await call(acct('owner'), 'commit_snapshot', { sha256: h, constraint_stage: c.status, summary: `${c.type} constraint at ${c.status} (${Math.round(c.leadShare * 100)}% of lead time); ${offers.length} open offers priced` });
  return { sha256: h, constraint: c.status };
}

/** Ask the private CFO (TEE) to review an offer against the committed snapshot and execute on-chain. */
export async function reviewOffer(offerId: string) {
  const KEY = process.env.NEARAI_API_KEY;
  if (!KEY) throw new Error('NEARAI_API_KEY is not set');
  const [, snap] = await view('get_state');
  const snapshotText = fs.readFileSync(path.join(SNAPS, `${snap.sha256}.json`), 'utf8');
  if (sha(snapshotText) !== snap.sha256) throw new Error('local snapshot does not match the committed hash');
  const tpl = await view('request_template', { offer_id: offerId });
  const request = Buffer.from(`${tpl.prefix},{"type":"text","text":${JSON.stringify(snapshotText)}}${tpl.suffix}`);
  const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity', 'x-no-aliasing': 'true' };
  const res = await fetch(`${API}/chat/completions`, { method: 'POST', headers, body: request });
  const response = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${response.toString().slice(0, 300)}`);
  if (!JSON.parse(response.toString()).choices?.[0]?.message?.content) throw new Error('the CFO model returned no answer (token budget); try again');
  let signature: any;
  for (let i = 0; i < 15 && !signature; i++) {
    const r = await fetch(`${API}/signature/${JSON.parse(response.toString()).id}?signing_algo=ed25519`, { headers });
    const j: any = r.ok ? await r.json() : null;
    if (j?.signature) signature = j; else await new Promise((ok) => setTimeout(ok, 2000));
  }
  if (!signature) throw new Error('no TEE signature');
  if (signature.text !== `${tpl.model}:${sha(request)}:${sha(response)}`) throw new Error('signed text does not match our bytes');
  const dir = path.join(EVIDENCE, offerId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), request);
  fs.writeFileSync(path.join(dir, 'response.json'), response);
  fs.writeFileSync(path.join(dir, 'signature.json'), JSON.stringify(signature));
  return call(acct('owner'), 'execute_review', {
    offer_id: offerId, request: request.toString('base64'), response: response.toString('base64'), signature_hex: signature.signature, signer_hex: signature.signing_address,
  });
}
