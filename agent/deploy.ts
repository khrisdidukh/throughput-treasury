// Deploy the treasury to the owner account, register the attested signer, fund it, post three vendor offers.
import fs from 'node:fs';
import { NEAR, acct, call } from './near.js';

const [signer, quoteSha] = process.argv.slice(2);
const owner = acct('owner');
await owner.deployContract(fs.readFileSync(new URL('../contracts/treasury/target/wasm32-unknown-unknown/release/throughput_treasury.wasm', import.meta.url)));
await call(owner, 'new', { owner: owner.id, model: 'Qwen/Qwen3.8-27B', min_roi_x100: 300, max_spend_per_week: NEAR(2).toString() });
await call(owner, 'register_signer', { signer_hex: signer, quote_sha256: quoteSha });
console.log('deployed + signer registered on', owner.id);

const offers = [
  ['vendor-triage', { id: 'triage-agent', stage: 'Open', lever: 'policy', description: 'Triage agent: decides every newly opened issue within 24 hours (accept, decline, or ask for information), prunes the stale backlog and keeps a WIP limit on Open.', price_eur_per_week: 400, pay_per_week: NEAR(0.4).toString() }],
  ['vendor-review', { id: 'review-bot', stage: 'Review In Progress', lever: 'automate', description: 'Code-review bot: automates about half of the review work (style, tests, obvious bugs) in Review In Progress.', price_eur_per_week: 300, pay_per_week: NEAR(0.3).toString() }],
  ['vendor-dev', { id: 'senior-dev', stage: 'In Progress', lever: 'hire', description: 'One additional senior developer, full time, working on issues In Progress.', price_eur_per_week: 2500, pay_per_week: NEAR(1).toString() }],
] as const;
for (const [role, o] of offers) {
  await call(acct(role), 'post_offer', o);
  console.log('offer posted:', o.id, 'by', acct(role).id);
}
