// Throughput Treasury page. Chain state comes straight from NEAR RPC; proofs are checked in the browser.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => '€' + Math.round(Number(n)).toLocaleString('en-US');
const near = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 3 });
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const sha = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const enc = new TextEncoder();

let cfg, state, offers = [], decisions = [];

async function view(method, args = {}) {
  const r = await fetch(cfg.rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tt', method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: cfg.contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error || j.result.error).slice(0, 200));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}

async function ed25519Verify(pubHex, msg, sigHex) {
  try {
    const key = await crypto.subtle.importKey('raw', unhex(pubHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, unhex(sigHex), msg);
  } catch {
    const { ed25519 } = await import('https://cdn.jsdelivr.net/npm/@noble/curves@1.6.0/esm/ed25519.js');
    return ed25519.verify(unhex(sigHex), msg, unhex(pubHex));
  }
}

const OUTCOME = { FUNDED: 'Funded', REJECTED_BY_AI: 'Rejected by the CFO', BLOCKED_BY_POLICY: 'Blocked by policy' };
const LEVER = { automate: 'automates work', hire: 'adds a person', move: 'moves a person', policy: 'changes a decision rule' };

function renderFacts() {
  const [policy, snap, balance, spent] = state;
  $('#facts').innerHTML = `
    <span>Treasury <b>${near(balance)} NEAR</b></span>
    <span>Spent this week <b>${near(spent)} of ${near(policy.max_spend_per_week)}</b></span>
    <span>Minimum return <b>${policy.min_roi_x100 / 100}× price</b></span>
    <span>Constraint now <b>${esc(snap?.constraint_stage || '—')}</b></span>`;
  $('#contract-link').textContent = cfg.contract;
  $('#contract-link').href = `https://testnet.nearblocks.io/address/${cfg.contract}`;
}

async function renderFlow() {
  const snap = state[1];
  if (!snap) return;
  const s = await (await fetch(`/api/snapshot/${snap.sha256}`)).json().catch(() => null);
  if (!s) return;
  const parts = s.flow.whereLeadTimeGoes;
  const c = s.constraint.stage;
  $('#flow').innerHTML = parts.map((p) => {
    const pct = parseFloat(p.share);
    return `<div class="seg ${p.kind} ${p.status === c ? 'drum' : ''} ${pct < 12 ? 'small' : ''}" style="flex-basis:${Math.max(pct, 6)}%" title="${esc(p.status)}: ${p.share} of lead time, ${p.daysPerItem} days per item">
      <span class="pct">${p.share}</span><b>${esc(p.status)}</b><span class="days">${p.daysPerItem} days per item${p.utilization ? `, ${p.utilization} busy` : ''}</span></div>`;
  }).join('');
  $('#flow-src').textContent = `Lead time of delivered work, ${s.source}`;
  const k = s.flow.constraints.find((x) => x.waitIn === c) || s.flow.constraints[0];
  $('#why').innerHTML = k.evidence.slice(0, 4).map((e) => `<li>${esc(e[0].toUpperCase() + e.slice(1))}.</li>`).join('');
}

function renderDecisions() {
  const byId = Object.fromEntries(offers.map((o) => [o.id, o]));
  const list = [...decisions].reverse();
  if (!list.length) { $('#decisions').innerHTML = '<p class="empty">No decisions yet. Pitch the CFO below.</p>'; return; }
  $('#decisions').innerHTML = list.map((d, i) => {
    const o = byId[d.offer_id] || {};
    const atC = o.stage === state[1]?.constraint_stage;
    return `<article class="dec" data-i="${decisions.length - 1 - i}">
      <div class="dec-row">
        <div><h3>${esc(d.offer_id)}</h3><p class="desc">${esc(o.description)}</p>
          <div class="meta"><span class="chip ${atC ? 'drum' : ''}">${esc(o.stage)}</span> ${esc(LEVER[o.lever] || o.lever)}, vendor ${esc(d.vendor)}</div></div>
        <div><span class="col-label">Price</span><span class="big">${eur(o.price_eur_per_week * 52)}</span><span class="col-label">per year</span></div>
        <div><span class="col-label">CFO in the enclave says</span><span class="big ai-${esc(d.ai_decision)}">${esc(d.ai_decision)}</span><span class="col-label">real value ${eur(d.real_value_per_year_eur)} / yr</span></div>
        <div><span class="col-label">The contract</span><span class="outcome o-${esc(d.outcome)}">${OUTCOME[d.outcome] || esc(d.outcome)}</span><span class="col-label">${BigInt(d.paid) > 0n ? `paid ${near(d.paid)} NEAR` : 'paid nothing'}</span></div>
      </div>
      <p class="reason"><q>${esc(d.reason)}</q></p>
      <div class="dec-foot"><button class="btn" data-proof>Check the proof</button><span class="hash">signed by ${d.signer.slice(0, 16)}…, response ${d.response_hash.slice(0, 16)}…</span></div>
      <div class="proof" hidden></div>
    </article>`;
  }).join('');
}

async function checkProof(article) {
  const d = decisions[Number(article.dataset.i)];
  const box = article.querySelector('.proof');
  box.hidden = false;
  const steps = [];
  const draw = (final) => {
    box.innerHTML = `<ol>${steps.map((s) => `<li class="${s.ok === null ? 'wait' : s.ok ? 'ok' : 'bad'}"><span>${s.ok === null ? '…' : s.ok ? '✓' : '✗'}</span><div>${s.t}${s.h ? `<div class="hash">${s.h}</div>` : ''}</div></li>`).join('')}</ol>${final || ''}`;
  };
  const add = (t, ok, h) => { steps.push({ t, ok, h }); draw(); };
  try {
    const get = async (f) => { const r = await fetch(`/api/evidence/${d.offer_id}/${f}.json`); if (!r.ok) throw new Error(`the ${f} bundle is not on this server (live runs are kept until the demo server restarts)`); return new Uint8Array(await r.arrayBuffer()); };
    const [req, resp, sigB] = await Promise.all([get('request'), get('response'), get('signature')]);
    const sig = JSON.parse(new TextDecoder().decode(sigB));
    const hReq = await sha(req), hResp = await sha(resp);
    add('The request bytes hash to what the contract recorded', hReq === d.request_hash, hReq);
    add('The response bytes hash to what the contract recorded', hResp === d.response_hash, hResp);
    const reqJ = JSON.parse(new TextDecoder().decode(req));
    const snapText = reqJ.messages.at(-1).content.at(-1).text;
    const hSnap = await sha(enc.encode(snapText));
    add('The CFO was shown exactly the committed flow snapshot', hSnap === d.snapshot_sha256, hSnap);
    const text = `${reqJ.model}:${hReq}:${hResp}`;
    const sigOk = await ed25519Verify(d.signer, enc.encode(text), sig.signature);
    add(`The enclave's ed25519 signature over <code>model:sha256(request):sha256(response)</code> is valid`, sigOk, sig.signature.slice(0, 64) + '…');
    const quote = await view('signer_quote', { signer_hex: d.signer });
    add('The signing key is registered on-chain with its TDX attestation', !!quote, quote ? `TDX quote sha256 ${quote}` : 'not registered');
    const respJ = JSON.parse(new TextDecoder().decode(resp));
    const flipped = d.ai_decision === 'FUND' ? 'REJECT' : 'FUND';
    respJ.choices[0].message.content = respJ.choices[0].message.content.replace(/("decision"\s*:\s*")(FUND|REJECT)/, `$1${flipped}`);
    const forged = enc.encode(JSON.stringify(respJ));
    const forgedOk = await ed25519Verify(d.signer, enc.encode(`${reqJ.model}:${hReq}:${await sha(forged)}`), sig.signature);
    add(`Forgery test: the same answer with the decision changed to ${flipped} fails the signature`, !forgedOk);
    const all = steps.every((s) => s.ok);
    draw(`<p class="verdict ${all ? 'ok' : 'bad'}">${all ? 'Proof holds. This decision came from the enclave, unchanged, about this exact snapshot.' : 'Proof does not hold.'}</p>`);
  } catch (e) {
    draw(`<p class="verdict bad">${esc(e.message)}</p>`);
  }
}

async function load() {
  [state, offers, decisions] = await Promise.all([view('get_state'), view('get_offers'), view('get_decisions')]);
  renderFacts();
  renderDecisions();
}

$('#decisions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-proof]');
  if (b) checkProof(b.closest('.dec'));
});

document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => {
  const p = JSON.parse(b.dataset.p);
  const f = $('#offer');
  for (const [k, v] of Object.entries(p)) f.elements[k].value = v;
  f.elements.description.focus();
}));

const STATE_TEXT = { posting: 'Posting your offer on-chain…', pricing: 'The engine is pricing it against the flow…', reviewing: 'The CFO is reviewing it inside the enclave…' };
$('#offer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(new FormData(f));
  body.price_eur_per_week = Number(body.price_eur_per_week);
  $('#send').disabled = true;
  const live = $('#live');
  try {
    const r = await fetch('/api/offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let job = await r.json();
    if (!r.ok) throw new Error(job.error);
    while (!['done', 'failed'].includes(job.state)) {
      live.innerHTML = `<span class="spinner"></span>${STATE_TEXT[job.state]}`;
      await new Promise((ok) => setTimeout(ok, 2500));
      job = await (await fetch(`/api/job/${job.id}`)).json();
    }
    if (job.state === 'failed') throw new Error(job.error);
    const before = decisions.length;
    for (let i = 0; i < 8; i++) { await load(); if (decisions.length > before) break; await new Promise((ok) => setTimeout(ok, 1500)); }
    live.textContent = `${OUTCOME[job.decision.outcome]}. It's at the top of the list.`;
    await renderFlow();
    document.querySelector('.dec')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    live.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  } finally {
    $('#send').disabled = false;
  }
});

(async () => {
  cfg = await (await fetch('/api/config')).json();
  $('#stage').innerHTML = cfg.stages.map((s) => `<option>${esc(s)}</option>`).join('');
  if (!cfg.canReview) { $('#send').disabled = true; $('#live').textContent = 'Live reviews are off on this copy of the site. Every past decision is still verifiable above.'; }
  try { await load(); await renderFlow(); } catch (e) { $('#decisions').innerHTML = `<p class="err">Could not read the contract: ${esc(e.message)}</p>`; }
})();
