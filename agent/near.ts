import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import fs from 'node:fs';
import path from 'node:path';

export const RPC = process.env.NEAR_RPC || 'https://rpc.testnet.fastnear.com';
export const provider = new JsonRpcProvider({ url: RPC });
const KEYS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'keys');

export function acct(role: string): Account & { id: string } {
  // keys from TT_ACCOUNTS ({"owner":{account_id,private_key},...}), TT_<ROLE>, or keys/tt-<role>-*.json
  const all = process.env.TT_ACCOUNTS ? JSON.parse(process.env.TT_ACCOUNTS) : {};
  const env = process.env[`TT_${role.toUpperCase().replace(/-/g, '_')}`];
  const k = all[role] ? all[role] : env ? JSON.parse(env) : JSON.parse(fs.readFileSync(path.join(KEYS, fs.readdirSync(KEYS).find((f) => f.startsWith(`tt-${role}-`))!), 'utf8'));
  const a = new Account(k.account_id, provider, KeyPairSigner.fromSecretKey(k.private_key)) as Account & { id: string };
  a.id = k.account_id;
  return a;
}
export const CONTRACT = process.env.TREASURY_CONTRACT || (() => { try { return acct('owner').id; } catch { return 'tt-owner-1333.testnet'; } })();
export const call = (a: Account, methodName: string, args: object, deposit = 0n) =>
  a.callFunction({ contractId: CONTRACT, methodName, args, gas: 300_000_000_000_000n, deposit }) as Promise<any>;
export const view = (method: string, args: object = {}) => provider.callFunction({ contractId: CONTRACT, method, args }) as Promise<any>;
export const NEAR = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 18n;
