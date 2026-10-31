// usage: npx tsx agent/snapshot.ts — build the flow snapshot with the engine, price open offers, commit the hash
import { commitSnapshot } from './cfo.js';
console.log(await commitSnapshot());
