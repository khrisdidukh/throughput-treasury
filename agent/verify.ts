// Offline re-verification of CFO bundles: exact-byte hashes + TEE ed25519 signature. usage: npx tsx agent/verify.ts evidence/*/
import crypto from 'node:crypto';
import fs from 'node:fs';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
let bad = 0;
for (const dir of process.argv.slice(2)) {
  const req = fs.readFileSync(`${dir}/request.json`), resp = fs.readFileSync(`${dir}/response.json`);
  const s = JSON.parse(fs.readFileSync(`${dir}/signature.json`, 'utf8'));
  const text = `${JSON.parse(req.toString()).model}:${sha(req)}:${sha(resp)}`;
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(s.signing_address, 'hex')]), format: 'der', type: 'spki' });
  const ok = text === s.text && crypto.verify(null, Buffer.from(text), key, Buffer.from(s.signature, 'hex'));
  // tamper test: flip the decision inside the model's answer and confirm the signature no longer holds
  const j = JSON.parse(resp.toString());
  const content: string = j.choices[0].message.content;
  j.choices[0].message.content = content.replace(/("decision"\s*:\s*")(FUND|REJECT)/, (_m, a, d) => a + (d === 'FUND' ? 'REJECT' : 'FUND'));
  if (j.choices[0].message.content === content) throw new Error(`${dir}: could not locate the decision to tamper with`);
  const forged = Buffer.from(JSON.stringify(j));
  const forgedOk = crypto.verify(null, Buffer.from(`${JSON.parse(req.toString()).model}:${sha(req)}:${sha(forged)}`), key, Buffer.from(s.signature, 'hex'));
  const a = JSON.parse(JSON.parse(resp.toString()).choices[0].message.content.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  if (!ok || forgedOk) bad++;
  console.log(`${ok && !forgedOk ? 'OK  ' : 'FAIL'} ${dir.replace(/\/$/, '').split('/').pop()!.padEnd(16)} ${a.decision.padEnd(7)} real ${a.real_value_per_year_eur} / paper ${a.paper_value_per_year_eur} EUR/yr  (flipped decision ${forgedOk ? 'VERIFIES — BAD' : 'rejected'})`);
}
process.exit(bad ? 1 : 0);
