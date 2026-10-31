// Theory of Constraints + throughput accounting (T, I, OE) + an Adizes lens on root causes.
import type { FlowSummary, StatusMetrics } from './metrics.js';
import { DEFAULT_MONEY, type MoneyAssumptions } from './types.js';

export type ConstraintType = 'policy' | 'capacity';

export interface Constraint {
  status: string; // the queue where delivered work waited
  servedBy: string; // the work stage (or decision) it waits for
  type: ConstraintType; // policy = decisions/rules hold work; capacity = the work stage is saturated
  leadShare: number; // share of delivered items' lead time spent here
  daysPerItem: number; // average days a delivered item spent here
  wipGrowth: number;
  utilization: number; // of the serving work stage
  score: number;
  evidence: string[];
}

export type AdizesRole = 'P' | 'A' | 'E' | 'I';
export interface AdizesDiagnosis {
  dominant: AdizesRole;
  scores: Record<AdizesRole, number>;
  meaning: string;
  evidence: string[];
}

export interface Scenario {
  label: string;
  lever: 'automate' | 'hire' | 'move' | 'free' | 'policy';
  status: string; // stage (work status or queue) the change applies to
  automationPct?: number; // 0..1 of the work at a work stage done by automation
  addPeople?: number;
  removePeople?: number;
  hire?: number; // of addPeople, new paid hires
  queueCutPct?: number; // policy change: share of waiting removed from a queue (WIP limit, triage SLA, pruning)
  from?: string; // for moves: where the person comes from
}

export interface ScenarioResult {
  scenario: Scenario;
  touchesConstraint: boolean;
  throughputPerWeek: { before: number; after: number };
  leadTimeDays: { before: number; after: number }; // mean lead time of delivered items
  money: {
    realPerYear: number;
    paperPerYear: number; // freed hours that only become money if people are redeployed
    breakdown: { opex: number; leadTime: number; throughput: number };
  };
  verdict: string;
}

const UTIL_SATURATED = 0.8;
const kingman = (rho: number) => {
  const r = Math.min(0.97, Math.max(0.05, rho));
  return r / (1 - r);
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

function servingStage(flow: FlowSummary, q: StatusMetrics): StatusMetrics | undefined {
  const st = new Map(flow.statuses.map((x) => [x.status, x] as const));
  return q.next.map((n) => st.get(n.status)).find((m) => m && m.kind === 'active');
}

/** Where delivered work waited most, classified as policy (decisions) or capacity (saturated stage). */
export function findConstraints(flow: FlowSummary, top = 3): Constraint[] {
  const out: Constraint[] = [];
  for (const s of flow.statuses) {
    if (s.kind !== 'queue' || s.leadShare < 0.03) continue;
    const work = servingStage(flow, s);
    const servedBy = work?.status ?? s.next[0]?.status ?? 'decision';
    const util = work?.utilization ?? 0;
    const growth = s.wipFirstThird > 0 ? s.wipLastThird / s.wipFirstThird : 1;
    const type: ConstraintType = s.role !== 'intake' && util >= UTIL_SATURATED ? 'capacity' : 'policy';
    const score = s.leadShare * (1 + Math.max(0, growth - 1)) * (type === 'capacity' ? 1 + util : 1);
    const ev = [
      `delivered items spent ${pct(s.leadShare)} of their lead time waiting in "${s.status}" (${s.meanDaysPerDelivered.toFixed(1)} days per item on average)`,
      `85% of waits in "${s.status}" were shorter than ${s.p85Days.toFixed(0)} days — the long tail is where the time goes`,
      growth >= 1.1 ? `the queue grew ${pct(growth - 1)} over the period` : growth <= 0.9 ? `the queue shrank ${pct(1 - growth)}` : `the queue was stable (${s.avgWip.toFixed(0)} items on average)`,
    ];
    if (work) ev.push(`"${servedBy}" works at ${pct(util)} of its demonstrated capacity (${work.exitsPerWeek.toFixed(1)} of ${work.capacityPerWeek.toFixed(0)} items/week) — ${util >= UTIL_SATURATED ? 'saturated' : 'it has room, so the wait is a decision, not a lack of hands'}`);
    if (s.staleItems > 20) ev.push(`${s.staleItems} items have sat here for more than ${flow.staleDays} days (aged inventory)`);
    out.push({ status: s.status, servedBy, type, leadShare: s.leadShare, daysPerItem: s.meanDaysPerDelivered, wipGrowth: growth, utilization: util, score, evidence: ev });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, top);
}

/** Adizes lens: which management role (PAEI) is missing at the constraint? Evidence-based, not a personality test. */
export function adizes(flow: FlowSummary, c: Constraint): AdizesDiagnosis {
  const q = flow.statuses.find((s) => s.status === c.status);
  const w = flow.statuses.find((s) => s.status === c.servedBy);
  const ev: Record<AdizesRole, string[]> = { P: [], A: [], E: [], I: [] };
  const sc: Record<AdizesRole, number> = { P: 0, A: 0, E: 0, I: 0 };
  if (w) {
    sc.P += c.type === 'capacity' ? 0.6 + w.utilization : w.utilization * 0.4;
    if (w.utilization >= UTIL_SATURATED) ev.P.push(`"${w.status}" runs at ${pct(w.utilization)} of its demonstrated capacity`);
    if (w.people && w.people < 3) { sc.P += 0.2; ev.P.push(`only ~${w.people.toFixed(1)} people move work out of "${w.status}" in a typical week`); }
  }
  sc.A += Math.min(1, flow.reopenRate * 4 + flow.backflowsPerItem * 0.6 + flow.batchMoveShare * 0.8);
  if (flow.reopenRate > 0.05) ev.A.push(`${pct(flow.reopenRate)} of finished items were reopened`);
  if (flow.backflowsPerItem > 0.2) ev.A.push(`${flow.backflowsPerItem.toFixed(2)} backward moves per item (rework loops)`);
  if (flow.batchMoveShare > 0.15) ev.A.push(`${pct(flow.batchMoveShare)} of status changes are bulk updates within 2 minutes — the board is updated after the fact`);
  if (c.type === 'policy') { sc.E += 0.8; ev.E.push(`work waits in "${c.status}" although "${c.servedBy}" has spare capacity — a decision is missing, not people`); }
  if (flow.resolvedWithoutWork > 0.2) { sc.E += 0.4; ev.E.push(`${pct(flow.resolvedWithoutWork)} of resolved items were closed without ever entering active work — late "no" decisions`); }
  if (flow.staleInventory > flow.throughputPerWeek * 26) { sc.E += 0.3; ev.E.push(`${flow.staleInventory} items untouched for ${flow.staleDays}+ days — about ${(flow.staleInventory / Math.max(1, flow.throughputPerWeek)).toFixed(0)} weeks of output parked in the backlog`); }
  sc.I += Math.min(1, flow.handoffsPerItem * 0.6);
  if (flow.handoffsPerItem > 0.5) ev.I.push(`${flow.handoffsPerItem.toFixed(2)} assignee handoffs per item`);
  if (/(needs|awaiting|waiting|feedback|committer|approval|review)/i.test(c.status)) { sc.I += 0.5; ev.I.push(`"${c.status}" means waiting on another person or role`); }
  if (q && q.next.length > 1 && q.next[0].pct < 0.6) { sc.I += 0.2; ev.I.push(`work leaving "${q.status}" splits across ${q.next.length} paths — unclear routing`); }

  const dominant = (Object.keys(sc) as AdizesRole[]).sort((a, b) => sc[b] - sc[a])[0];
  const meaning: Record<AdizesRole, string> = {
    P: 'Producing gap — the work stage lacks throughput. Add or move capacity there, or automate the work itself.',
    A: 'Administering gap — work is lost to rework and unclear standards. Fix definitions of ready/done and automate checks before adding people.',
    E: 'Entrepreneuring gap — nobody decides quickly what to start and what to drop. Name an intake owner, set a triage SLA and a WIP limit, prune the backlog.',
    I: 'Integrating gap — work waits between people. Reduce handoffs, make ownership explicit, pair or swarm across the boundary.',
  };
  return { dominant, scores: sc, meaning: meaning[dominant], evidence: ev[dominant] };
}

/** Throughput the work stages could sustain if stage `status` had its capacity multiplied by `factor`. */
function systemCapacity(flow: FlowSummary, status?: string, factor = 1): number {
  const T = flow.throughputPerWeek;
  const work = flow.statuses.filter((x) => x.kind === 'active' && x.exitsPerWeek >= Math.max(0.5, 0.1 * T) && x.capacityPerWeek > 0);
  if (!work.length) return T;
  return Math.min(...work.map((x) => T * ((x.capacityPerWeek * (x.status === status ? factor : 1)) / x.exitsPerWeek)));
}

/** Simulate one change and price it (throughput accounting). */
export function simulate(flow: FlowSummary, c: Constraint, s: Scenario, m: MoneyAssumptions = DEFAULT_MONEY): ScenarioResult {
  const st = new Map(flow.statuses.map((x) => [x.status, x] as const));
  const target = st.get(s.status);
  const work = target?.kind === 'active' ? target : target ? servingStage(flow, target) : undefined;
  const touchesConstraint = s.status === c.status || s.status === c.servedBy;
  const T = flow.throughputPerWeek;
  const demand = Math.max(flow.arrivalsPerWeek, T);
  const LT = flow.leadTimeMeanDays;

  // capacity factor at the work stage
  let capFactor = 1;
  if (work) {
    const people = Math.max(1, work.people || 1);
    capFactor = (people + (s.addPeople ?? 0) - (s.removePeople ?? 0)) / people;
    if (s.automationPct) capFactor /= 1 - Math.min(0.9, s.automationPct);
  }
  // waiting time in front of the work stage
  let waitSaved = 0;
  const queues = flow.statuses.filter((q) => q.kind === 'queue' && (q.status === s.status || servingStage(flow, q)?.status === work?.status));
  for (const q of queues) {
    const rho = work?.utilization ?? 0.5;
    const congestion = rho >= UTIL_SATURATED ? kingman(rho / capFactor) / kingman(rho) : 1; // capacity only shortens queues at saturated stages
    const policy = q.status === s.status ? 1 - (s.queueCutPct ?? 0) : 1;
    waitSaved += q.meanDaysPerDelivered * (1 - congestion * policy);
  }
  const activeSaved = work && s.automationPct ? work.meanDaysPerDelivered * Math.min(0.9, s.automationPct) : 0;
  const LTafter = Math.max(0.5, LT - waitSaved - activeSaved);

  // throughput: limited by the constraint
  const capNow = systemCapacity(flow);
  const capAfter = systemCapacity(flow, work?.status, capFactor);
  let Tafter = T;
  if (c.type === 'policy' && s.lever === 'policy' && s.status === c.status) Tafter = T + (s.queueCutPct ?? 0) * (Math.min(demand, capAfter) - T);
  if (c.type === 'capacity' && s.status === c.servedBy && capFactor > 1) Tafter = Math.min(demand, T * (capAfter / capNow));
  if (capAfter < Tafter) Tafter = capAfter; // removing capacity can create a new constraint
  Tafter = Math.max(0, Tafter);

  // money (per year)
  const wk = 52;
  const freedHoursWeek = work && s.automationPct ? Math.max(1, work.people) * m.hoursPerWeek * work.utilization * s.automationPct : 0;
  const opex = (s.lever === 'free' ? (s.removePeople ?? 0) * m.hoursPerWeek * m.hourlyCost * wk : 0) - (s.hire ?? 0) * m.hoursPerWeek * m.hourlyCost * wk;
  const leadMoney = ((LT - LTafter) / 7) * Tafter * m.costOfDelayPerItemWeek * wk;
  const tMoney = (Tafter - T) * m.valuePerItem * wk;
  const paper = s.lever === 'automate' && Tafter - T < 0.05 ? freedHoursWeek * m.hourlyCost * wk : 0;
  const real = opex + leadMoney + tMoney;

  let verdict: string;
  if (s.lever === 'automate' && !touchesConstraint)
    verdict = `Automation on paper: "${s.status}" is not where work waits, so ~${Math.round(freedHoursWeek)} freed hours/week barely change delivery. They turn into money only if those people move to "${c.servedBy}" or the cost is actually removed.`;
  else if (Tafter < T - 0.05)
    verdict = `Careful: this creates a new constraint — throughput drops ${(T - Tafter).toFixed(1)} items/week.`;
  else if (s.lever === 'free')
    verdict = `Real saving: "${s.status}" has spare capacity, so one person can move to other work without slowing delivery.`;
  else if (Tafter > T + 0.05 || LT - LTafter > 0.5)
    verdict = `Real gain: throughput ${T.toFixed(1)}→${Tafter.toFixed(1)} items/week, average lead time ${LT.toFixed(0)}→${LTafter.toFixed(0)} days.`;
  else if (c.type === 'policy' && (s.lever === 'hire' || s.lever === 'automate' || s.lever === 'move'))
    verdict = `Little effect: work waits for a decision in "${c.status}", not for capacity in "${c.servedBy}" (it runs at ${pct(c.utilization)}). More hands won't move it.`;
  else verdict = `Little measurable effect on delivery.`;

  return {
    scenario: s, touchesConstraint,
    throughputPerWeek: { before: T, after: Tafter },
    leadTimeDays: { before: LT, after: LTafter },
    money: { realPerYear: real, paperPerYear: paper, breakdown: { opex, leadTime: leadMoney, throughput: tMoney } },
    verdict,
  };
}

/** Candidate actions around the top constraint, ranked by real money per year. */
export function recommend(flow: FlowSummary, constraints: Constraint[], m: MoneyAssumptions = DEFAULT_MONEY): ScenarioResult[] {
  const c = constraints[0];
  if (!c) return [];
  const T = flow.throughputPerWeek;
  const work = flow.statuses.filter((s) => s.kind === 'active' && s.exitsPerWeek >= Math.max(0.5, 0.1 * T));
  const scenarios: Scenario[] = [
    { label: `Decide faster at "${c.status}": owner + SLA + WIP limit (halve the wait)`, lever: 'policy', status: c.status, queueCutPct: 0.5 },
    { label: `Automate half of the work in "${c.servedBy}"`, lever: 'automate', status: c.servedBy, automationPct: 0.5 },
    { label: `Hire one more person for "${c.servedBy}"`, lever: 'hire', status: c.servedBy, addPeople: 1, hire: 1 },
  ];
  const spare = [...work].filter((s) => s.status !== c.servedBy && s.people >= 2).sort((a, b) => a.utilization - b.utilization)[0];
  if (spare) {
    scenarios.push({ label: `Move one person from "${spare.status}" to "${c.servedBy}"`, lever: 'move', status: c.servedBy, addPeople: 1, from: spare.status });
    scenarios.push({ label: `Free one person from "${spare.status}" (runs at ${pct(spare.utilization)})`, lever: 'free', status: spare.status, removePeople: 1 });
  }
  const busiest = [...work].filter((s) => s.status !== c.servedBy).sort((a, b) => b.exitsPerWeek - a.exitsPerWeek)[0];
  if (busiest) scenarios.push({ label: `Automate half of "${busiest.status}" (the obvious target)`, lever: 'automate', status: busiest.status, automationPct: 0.5 });
  return scenarios.map((s) => simulate(flow, c, s, m)).sort((a, b) => b.money.realPerYear - a.money.realPerYear);
}
