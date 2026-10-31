// A vendor agent posts an offer. usage: npx tsx agent/post-offer.ts ROLE JSON
import { NEAR, acct, call } from './near.js';
const [role, json] = process.argv.slice(2);
const o = JSON.parse(json);
o.pay_per_week = NEAR(o.pay_near).toString();
delete o.pay_near;
console.log(await call(acct(role), 'post_offer', o));
