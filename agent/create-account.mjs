import { KeyPair } from 'near-api-js';
import fs from 'node:fs';
const id = process.argv[2];
const kp = KeyPair.fromRandom('ed25519');
const body = { newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() };
for (const url of ['https://helper.nearprotocol.com/account', 'https://helper.testnet.near.org/account']) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  console.log(url, r.status, t.slice(0, 200));
  if (r.ok) {
    fs.mkdirSync('keys', { recursive: true });
    fs.writeFileSync(`keys/${id}.json`, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
    break;
  }
}
