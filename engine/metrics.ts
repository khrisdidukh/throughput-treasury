import { backflows, batchMoves, handoffs, reopenCount, toSegments } from './segments.js';
import { statusKind } from './status.js';
import { DAY, WEEK, type AnalysisWindow, type IssueHistory, type Segment, type StatusConfig, type StatusKind } from './types.js';

export interface StatusMetrics {
  status: string;
  kind: StatusKind;
  role: 'intake' | 'handoff' | 'work';
  itemDays: number; // total item-days spent in the status inside the window
  share: number; // share of all non-done item-days
  avgWip: number; // Little: itemDays / windowDays
  wipFirstThird: number;
  wipLastThird: number;
  entriesPerWeek: number;
  exitsPerWeek: number;
  capacityPerWeek: number; // demonstrated: 85th percentile of weekly exits (weeks with work waiting)
  utilization: number; // entries / capacity, clamped
  medianDays: number;
  p85Days: number;
  people: number; // distinct people moving items out of this status per active week (avg)
  next: { status: string; pct: number }[]; // where items go next
  backflowIn: number; // items that came back into this status from a later stage
  leadShare: number; // share of delivered items' lead time spent here
  meanDaysPerDelivered: number; // time in this status per delivered item (avg over all delivered items)
  staleItems: number; // items sitting here > staleDays at window end (aged inventory)
}

export interface FlowSummary {
  window: { from: string; to: string; weeks: number };
  issues: number;
  resolvedInWindow: number;
  createdInWindow: number;
  throughputPerWeek: number;
  arrivalsPerWeek: number;
  leadTimeMedianDays: number;
  leadTimeP85Days: number;
  flowEfficiency: number; // active / (active + queue) item-time for items resolved in window
  reopenRate: number;
  handoffsPerItem: number;
  backflowsPerItem: number;
  batchMoveShare: number; // share of status changes done within 2 min of the previous one
  resolvedWithoutWork: number; // share of resolved items that never entered an active status
  leadTimeMeanDays: number;
  inventory: number; // items not done at window end
  staleInventory: number; // of which untouched for > staleDays
  staleDays: number;
  systemCapacityPerWeek: number; // throughput the work stages could sustain (min over stages)
  statuses: StatusMetrics[];
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};
const clip = (s: Segment, w: AnalysisWindow) => Math.max(0, Math.min(s.end, w.to) - Math.max(s.start, w.from));
const INTAKE = /(backlog|to ?do|open|new|triage|selected|intake|requested)/i;

export function computeFlow(issues: IssueHistory[], window: AnalysisWindow, cfg?: StatusConfig, staleDays = 180): FlowSummary {
  const days = (window.to - window.from) / DAY;
  const weeks = days / 7;
  const third = (window.to - window.from) / 3;
  const segs: Segment[] = [];
  const perIssue = new Map<string, Segment[]>();
  for (const i of issues) {
    const s = toSegments(i, window, cfg).filter((x) => x.end > window.from && x.start < window.to);
    perIssue.set(i.key, s);
    segs.push(...s);
  }

  // --- per status aggregates
  const by = new Map<string, Segment[]>();
  for (const s of segs) if (s.kind !== 'done') (by.get(s.status) ?? by.set(s.status, []).get(s.status)!).push(s);
  const totalItemDays = segs.filter((s) => s.kind !== 'done').reduce((a, s) => a + clip(s, window) / DAY, 0);

  // first status seen on issues = intake candidates
  const firstStatus = new Map<string, number>();
  for (const i of issues) firstStatus.set(i.initialStatus, (firstStatus.get(i.initialStatus) ?? 0) + 1);

  // transitions inside window
  const nextCount = new Map<string, Map<string, number>>();
  const exitWeeks = new Map<string, Map<number, number>>();
  const exitPeople = new Map<string, Map<number, Set<string>>>();
  const entries = new Map<string, number>();
  const backIn = new Map<string, number>();
  const order = cfg?.order?.map((o) => o.toLowerCase());
  for (const i of issues)
    for (const c of i.statusChanges) {
      if (c.at < window.from || c.at > window.to) continue;
      const m = nextCount.get(c.from) ?? nextCount.set(c.from, new Map()).get(c.from)!;
      m.set(c.to, (m.get(c.to) ?? 0) + 1);
      const wk = Math.floor((c.at - window.from) / WEEK);
      const ew = exitWeeks.get(c.from) ?? exitWeeks.set(c.from, new Map()).get(c.from)!;
      ew.set(wk, (ew.get(wk) ?? 0) + 1);
      if (c.author) {
        const ep = exitPeople.get(c.from) ?? exitPeople.set(c.from, new Map()).get(c.from)!;
        (ep.get(wk) ?? ep.set(wk, new Set()).get(wk)!).add(c.author);
      }
      entries.set(c.to, (entries.get(c.to) ?? 0) + 1);
      if (order) {
        const a = order.indexOf(c.from.toLowerCase()), b = order.indexOf(c.to.toLowerCase());
        if (a >= 0 && b >= 0 && b < a) backIn.set(c.to, (backIn.get(c.to) ?? 0) + 1);
      }
    }
  // issues created in window enter their initial status
  for (const i of issues) if (i.created >= window.from && i.created <= window.to) entries.set(i.initialStatus, (entries.get(i.initialStatus) ?? 0) + 1);

  // where delivered items' lead time went
  const resolvedItems = issues.filter((i) => i.resolved && i.resolved >= window.from && i.resolved <= window.to);
  const leadBy = new Map<string, number>();
  let leadTotal = 0;
  for (const i of resolvedItems)
    for (const sg of toSegments(i, { from: i.created, to: i.resolved! }, cfg)) {
      if (sg.kind === 'done') continue;
      const d = (sg.end - sg.start) / DAY;
      leadBy.set(sg.status, (leadBy.get(sg.status) ?? 0) + d);
      leadTotal += d;
    }
  const staleCut = window.to - staleDays * DAY;

  const statuses: StatusMetrics[] = [];
  for (const [status, ss] of by) {
    const kind = statusKind(status, cfg);
    const itemDays = ss.reduce((a, s) => a + clip(s, window) / DAY, 0);
    const wipIn = (from: number, to: number) => ss.reduce((a, s) => a + Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)), 0) / (to - from);
    const closedDur = ss.filter((s) => !s.open && s.end >= window.from).map((s) => (s.end - s.start) / DAY);
    const nm = nextCount.get(status) ?? new Map();
    const nTot = [...nm.values()].reduce((a, b) => a + b, 0) || 1;
    const ew = exitWeeks.get(status) ?? new Map();
    const weekly = Array.from({ length: Math.max(1, Math.floor(weeks)) }, (_, k) => ew.get(k) ?? 0);
    const busyWeeks = weekly.filter((x) => x > 0);
    const capacity = q(busyWeeks, 0.85);
    const entriesPerWeek = (entries.get(status) ?? 0) / weeks;
    const ep = exitPeople.get(status);
    const people = ep && ep.size ? [...ep.values()].reduce((a, s) => a + s.size, 0) / ep.size : 0;
    const isIntake = kind === 'queue' && (INTAKE.test(status) || (firstStatus.get(status) ?? 0) > issues.length * 0.2);
    statuses.push({
      status, kind,
      role: kind === 'active' ? 'work' : isIntake ? 'intake' : 'handoff',
      itemDays, share: totalItemDays ? itemDays / totalItemDays : 0,
      avgWip: itemDays / days,
      wipFirstThird: wipIn(window.from, window.from + third),
      wipLastThird: wipIn(window.to - third, window.to),
      entriesPerWeek, exitsPerWeek: [...ew.values()].reduce((a, b) => a + b, 0) / weeks,
      capacityPerWeek: capacity,
      utilization: capacity ? Math.min(0.99, entriesPerWeek / capacity) : 0,
      medianDays: q(closedDur, 0.5), p85Days: q(closedDur, 0.85),
      people,
      next: [...nm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => ({ status: s, pct: n / nTot })),
      backflowIn: backIn.get(status) ?? 0,
      leadShare: leadTotal ? (leadBy.get(status) ?? 0) / leadTotal : 0,
      meanDaysPerDelivered: resolvedItems.length ? (leadBy.get(status) ?? 0) / resolvedItems.length : 0,
      staleItems: ss.filter((x) => x.open && x.start < staleCut).length,
    });
  }
  statuses.sort((a, b) => b.itemDays - a.itemDays);

  // --- item level
  const resolved = issues.filter((i) => i.resolved && i.resolved >= window.from && i.resolved <= window.to);
  const lead = resolved.map((i) => (i.resolved! - i.created) / DAY);
  let act = 0, que = 0, noWork = 0;
  for (const i of resolved) {
    const s = toSegments(i, { from: i.created, to: i.resolved! }, cfg);
    const a = s.filter((x) => x.kind === 'active').reduce((t, x) => t + x.end - x.start, 0);
    act += a;
    que += s.filter((x) => x.kind === 'queue').reduce((t, x) => t + x.end - x.start, 0);
    if (a === 0) noWork++;
  }
  const inWindow = issues.filter((i) => i.statusChanges.some((c) => c.at >= window.from && c.at <= window.to));
  const totalChanges = inWindow.reduce((a, i) => a + i.statusChanges.length, 0) || 1;

  const T = resolved.length / weeks;
  const work = statuses.filter((x) => x.kind === 'active' && x.exitsPerWeek >= Math.max(0.5, 0.1 * T) && x.capacityPerWeek > 0);
  const systemCapacityPerWeek = work.length ? Math.min(...work.map((x) => T * (x.capacityPerWeek / x.exitsPerWeek))) : T;
  const inventory = segs.filter((x) => x.open).length;
  const staleInventory = segs.filter((x) => x.open && x.start < staleCut).length;
  return {
    leadTimeMeanDays: lead.length ? lead.reduce((a, b) => a + b, 0) / lead.length : 0,
    inventory, staleInventory, staleDays, systemCapacityPerWeek,
    window: { from: new Date(window.from).toISOString().slice(0, 10), to: new Date(window.to).toISOString().slice(0, 10), weeks: Math.round(weeks) },
    issues: issues.length,
    resolvedInWindow: resolved.length,
    createdInWindow: issues.filter((i) => i.created >= window.from && i.created <= window.to).length,
    throughputPerWeek: resolved.length / weeks,
    arrivalsPerWeek: issues.filter((i) => i.created >= window.from && i.created <= window.to).length / weeks,
    leadTimeMedianDays: q(lead, 0.5),
    leadTimeP85Days: q(lead, 0.85),
    flowEfficiency: act + que ? act / (act + que) : 0,
    reopenRate: resolved.length ? resolved.filter((i) => reopenCount(i, cfg) > 0).length / resolved.length : 0,
    handoffsPerItem: resolved.length ? resolved.reduce((a, i) => a + handoffs(i), 0) / resolved.length : 0,
    backflowsPerItem: resolved.length ? resolved.reduce((a, i) => a + backflows(i, cfg?.order), 0) / resolved.length : 0,
    batchMoveShare: inWindow.reduce((a, i) => a + batchMoves(i), 0) / totalChanges,
    resolvedWithoutWork: resolved.length ? noWork / resolved.length : 0,
    statuses,
  };
}
