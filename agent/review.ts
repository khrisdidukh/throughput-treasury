// usage: npx tsx agent/review.ts OFFER_ID   — CFO (TEE) review of one offer, executed on-chain
import { reviewOffer } from './cfo.js';
const d = await reviewOffer(process.argv[2]);
console.log(`ON-CHAIN: ${d.outcome} — ${d.reason} (paid ${Number(BigInt(d.paid)) / 1e24} NEAR to ${d.vendor})`);
