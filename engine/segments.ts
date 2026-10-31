import { statusKind } from './status';
import type { AnalysisWindow, IssueHistory, Segment, StatusConfig } from './types';

/** Turn an issue's status history into continuous segments. Done-statuses end the timeline (until reopened). */
export function toSegments(issue: IssueHistory, window: AnalysisWindow, cfg?: StatusConfig): Segment[] {
  const out: Segment[] = [];
  const changes = [...issue.statusChanges].sort((a, b) => a.at - b.at);
  let status = changes.length ? changes[0].from || issue.initialStatus : issue.initialStatus;
  let start = issue.created;
  const push = (end: number, open: boolean) => {
    if (end > start) out.push({ issue: issue.key, status, kind: statusKind(status, cfg), start, end, open });
  };
  for (const c of changes) {
    if (c.at > window.to) break;
    push(c.at, false);
    status = c.to;
    start = c.at;
  }
  if (statusKind(status, cfg) !== 'done') push(window.to, true);
  return out;
}

/** Status transitions that happened within `withinMs` of the previous one on the same issue (bulk/after-the-fact updates). */
export function batchMoves(issue: IssueHistory, withinMs = 120_000): number {
  const c = [...issue.statusChanges].sort((a, b) => a.at - b.at);
  let n = 0;
  for (let i = 1; i < c.length; i++) if (c[i].at - c[i - 1].at <= withinMs) n++;
  return n;
}

export function reopenCount(issue: IssueHistory, cfg?: StatusConfig): number {
  return issue.statusChanges.filter((c) => statusKind(c.from, cfg) === 'done' && statusKind(c.to, cfg) !== 'done').length;
}

/** Count of times work went "backwards" (e.g. review -> in progress, changes suggested). */
export function backflows(issue: IssueHistory, order: string[] | undefined): number {
  if (!order?.length) return 0;
  const idx = (s: string) => order.findIndex((o) => o.toLowerCase() === s.toLowerCase());
  return issue.statusChanges.filter((c) => {
    const a = idx(c.from), b = idx(c.to);
    return a >= 0 && b >= 0 && b < a;
  }).length;
}

export function handoffs(issue: IssueHistory): number {
  return issue.assigneeChanges.filter((a) => a.from && a.to && a.from !== a.to).length;
}
