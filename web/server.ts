// Demo server: serves the web page, the evidence bundles and snapshots, and runs live CFO reviews of visitor offers.
// Chain state is read by the browser straight from NEAR RPC; this server is not trusted for it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, commitSnapshot, reviewOffer } from '../agent/cfo.js';
import { NEAR, acct, call, CONTRACT } from '../agent/near.js';

const PORT = Number(process.env.PORT || 8788);
const WEB = path.join(ROOT, 'web');
const STAGES = ['Open', 'Triage Needed', 'Patch Available', 'In Progress', 'Awaiting Feedback', 'Review In Progress'];
const VENDOR: Record<string, string> = { automate: 'vendor-review', hire: 'vendor-dev', move: 'vendor-dev', policy: 'vendor-triage' };
const canReview = (() => { try { acct('owner'); return !!process.env.NEARAI_API_KEY; } catch { return false; } })();

type Job = { id: string; offer: string; state: 'posting' | 'pricing' | 'reviewing' | 'done' | 'failed'; decision?: any; error?: string; at: number };
const jobs = new Map<string, Job>();
let running = false;
let today = { day: new Date().toISOString().slice(0, 10), n: 0 };
const DAILY_LIMIT = Number(process.env.DAILY_REVIEWS || 30);

async function run(job: Job, o: { stage: string; lever: string; description: string; price_eur_per_week: number }) {
  running = true;
  try {
    await call(acct(VENDOR[o.lever]), 'post_offer', { id: job.offer, ...o, pay_per_week: NEAR(0.1).toString() });
    job.state = 'pricing';
    await commitSnapshot();
    job.state = 'reviewing';
    job.decision = await reviewOffer(job.offer);
    job.state = 'done';
  } catch (e: any) {
    job.state = 'failed';
    job.error = String(e?.message || e).slice(0, 300);
  } finally {
    running = false;
  }
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function send(res: http.ServerResponse, code: number, body: string | Buffer, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function file(res: http.ServerResponse, p: string) {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return send(res, 404, '{"error":"not found"}');
  send(res, 200, fs.readFileSync(p), TYPES[path.extname(p)] || 'application/octet-stream');
}
const safe = (s: string) => /^[a-z0-9-]{1,64}$/.test(s);

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const p = url.pathname;
  if (p === '/api/config') return send(res, 200, JSON.stringify({ contract: CONTRACT, rpc: 'https://rpc.testnet.fastnear.com', canReview, stages: STAGES, busy: running }));
  let m = p.match(/^\/api\/evidence\/([a-z0-9-]+)\/(request|response|signature)\.json$/);
  if (m && safe(m[1])) return file(res, path.join(ROOT, 'evidence', m[1], `${m[2]}.json`));
  m = p.match(/^\/api\/snapshot\/([0-9a-f]{64})$/);
  if (m) return file(res, path.join(ROOT, 'snapshots', `${m[1]}.json`));
  m = p.match(/^\/api\/job\/([a-z0-9-]+)$/);
  if (m) return jobs.has(m[1]) ? send(res, 200, JSON.stringify(jobs.get(m[1]))) : send(res, 404, '{"error":"no such job"}');
  if (p === '/api/offer' && req.method === 'POST') {
    if (!canReview) return send(res, 503, '{"error":"Live reviews are off on this server: it has no NEAR AI key or no agent keys."}');
    if (running) return send(res, 429, '{"error":"The CFO is reviewing another offer. Try again in a minute."}');
    const d = new Date().toISOString().slice(0, 10);
    if (today.day !== d) today = { day: d, n: 0 };
    if (today.n >= DAILY_LIMIT) return send(res, 429, '{"error":"Today\'s demo review budget is used up. Every past decision is still verifiable below."}');
    let body = '';
    for await (const c of req) { body += c; if (body.length > 4000) return send(res, 413, '{"error":"too large"}'); }
    let o: any;
    try { o = JSON.parse(body); } catch { return send(res, 400, '{"error":"bad JSON"}'); }
    const description = String(o.description || '').trim();
    const price = Math.round(Number(o.price_eur_per_week));
    if (!STAGES.includes(o.stage)) return send(res, 400, '{"error":"Pick a stage of the workflow."}');
    if (!VENDOR[o.lever]) return send(res, 400, '{"error":"Pick what the offer does: automate, hire, move or policy."}');
    if (description.length < 10 || description.length > 400) return send(res, 400, '{"error":"Describe the offer in 10 to 400 characters."}');
    if (!(price >= 1 && price <= 100000)) return send(res, 400, '{"error":"Price must be between 1 and 100,000 EUR per week."}');
    today.n++;
    const id = `visitor-${Date.now().toString(36)}`;
    const job: Job = { id, offer: id, state: 'posting', at: Date.now() };
    jobs.set(id, job);
    run(job, { stage: o.stage, lever: o.lever, description, price_eur_per_week: price });
    return send(res, 202, JSON.stringify(job));
  }
  if (p === '/' || p === '/index.html') return file(res, path.join(WEB, 'index.html'));
  if (/^\/[a-z0-9-]+\.(js|css|svg)$/.test(p)) return file(res, path.join(WEB, p.slice(1)));
  send(res, 404, '{"error":"not found"}');
}).listen(PORT, () => console.log(`Throughput Treasury on http://localhost:${PORT} (live reviews ${canReview ? 'on' : 'off'})`));
