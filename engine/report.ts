import { adizes, findConstraints, recommend, simulate, type Constraint, type Scenario } from './economist';
import { computeFlow, type FlowSummary } from './metrics';
import { DEFAULT_MONEY, type IssueHistory, type MoneyAssumptions, type StatusConfig } from './types';

export interface Report {
  project: string;
  source: 'jira' | 'demo';
  generatedAt: string;
  money: MoneyAssumptions;
  flow: FlowSummary;
  constraints: Constraint[];
  adizes: ReturnType<typeof adizes> | null;
  recommendations: ReturnType<typeof recommend>;
  dataQuality: string[];
  headline: string;
  enoughData: boolean;
}

export function buildReport(project: string, source: Report['source'], issues: IssueHistory[], window: { from: number; to: number }, cfg?: StatusConfig, money: MoneyAssumptions = DEFAULT_MONEY): Report {
  const flow = computeFlow(issues, window, cfg);
  return fromFlow(project, source, flow, money);
}

export function fromFlow(project: string, source: Report['source'], flow: FlowSummary, money: MoneyAssumptions = DEFAULT_MONEY): Report {
  const constraints = findConstraints(flow);
  const c = constraints[0];
  const dq: string[] = [];
  if (flow.batchMoveShare > 0.15) dq.push(`${Math.round(flow.batchMoveShare * 100)}% of status changes were bulk updates (within 2 minutes of the previous one). Time-in-status is approximate where the board is updated after the fact.`);
  if (flow.resolvedWithoutWork > 0.2) dq.push(`${Math.round(flow.resolvedWithoutWork * 100)}% of resolved items never entered an active status — either closed without work or the workflow is skipped.`);
  if (flow.resolvedInWindow < 30) dq.push(`Only ${flow.resolvedInWindow} items were delivered in the period — treat results as indicative.`);
  const recs = recommend(flow, constraints, money);
  const best = recs[0];
  const headline = c
    ? `${Math.round(c.leadShare * 100)}% of delivered work's lead time is waiting in "${c.status}" — a ${c.type} constraint. ${best ? `Best move: ${best.scenario.label} (${fmtMoney(best.money.realPerYear, money.currency)}/year).` : ''}`
    : 'No dominant constraint found — work flows evenly.';
  return {
    project, source, generatedAt: new Date().toISOString(), money, flow, constraints,
    adizes: c ? adizes(flow, c) : null,
    recommendations: recs,
    dataQuality: dq,
    headline,
    enoughData: flow.resolvedInWindow >= 10,
  };
}

export function whatIf(r: Report, s: Scenario, money?: Partial<MoneyAssumptions>) {
  const m = { ...r.money, ...money };
  const c = r.constraints[0];
  if (!c) throw new Error('No constraint in this report');
  return simulate(r.flow, c, s, m);
}

export function fmtMoney(x: number, cur = 'EUR'): string {
  const sign = x < 0 ? '−' : '';
  const a = Math.abs(x);
  const v = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
  return `${sign}${cur === 'EUR' ? '€' : cur === 'USD' ? '$' : cur + ' '}${v}`;
}

/** Compact, model-friendly version for Rovo / MCP (a few KB). */
export function compact(r: Report) {
  const f = r.flow;
  return {
    project: r.project, source: r.source, window: f.window, headline: r.headline,
    flow: {
      deliveredPerWeek: +f.throughputPerWeek.toFixed(1), arrivingPerWeek: +f.arrivalsPerWeek.toFixed(1),
      systemCapacityPerWeek: +f.systemCapacityPerWeek.toFixed(1),
      leadTimeDays: { mean: Math.round(f.leadTimeMeanDays), median: Math.round(f.leadTimeMedianDays), p85: Math.round(f.leadTimeP85Days) },
      flowEfficiency: `${Math.round(f.flowEfficiency * 100)}%`,
      inventory: f.inventory, agedInventory: f.staleInventory, agedAfterDays: f.staleDays,
      reopenRate: `${Math.round(f.reopenRate * 100)}%`,
    },
    whereLeadTimeGoes: f.statuses.filter((s) => s.leadShare >= 0.02).sort((a, b) => b.leadShare - a.leadShare).map((s) => ({
      status: s.status, kind: s.kind, share: `${Math.round(s.leadShare * 100)}%`, daysPerItem: +s.meanDaysPerDelivered.toFixed(1),
      utilization: s.kind === 'active' ? `${Math.round(s.utilization * 100)}%` : undefined,
    })),
    constraints: r.constraints.map((c) => ({ waitIn: c.status, waitsFor: c.servedBy, type: c.type, leadShare: `${Math.round(c.leadShare * 100)}%`, evidence: c.evidence })),
    adizes: r.adizes && { missingRole: r.adizes.dominant, meaning: r.adizes.meaning, evidence: r.adizes.evidence },
    options: r.recommendations.map((x) => ({
      action: x.scenario.label, lever: x.scenario.lever,
      deliveredPerWeek: `${x.throughputPerWeek.before.toFixed(1)} → ${x.throughputPerWeek.after.toFixed(1)}`,
      leadTimeDays: `${Math.round(x.leadTimeDays.before)} → ${Math.round(x.leadTimeDays.after)}`,
      realValuePerYear: fmtMoney(x.money.realPerYear, r.money.currency),
      paperValuePerYear: x.money.paperPerYear ? fmtMoney(x.money.paperPerYear, r.money.currency) : undefined,
      verdict: x.verdict,
    })),
    assumptions: r.money,
    dataQuality: r.dataQuality,
  };
}
