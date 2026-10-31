// Upgrade the treasury code in place (state is kept).
import fs from 'node:fs';
import { acct } from './near.js';
await acct('owner').deployContract(fs.readFileSync(new URL('../contracts/treasury/target/wasm32-unknown-unknown/release/throughput_treasury.wasm', import.meta.url)));
console.log('redeployed');
