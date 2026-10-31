// Adapters from Jira REST shapes to IssueHistory.
import type { IssueHistory } from './types.js';

type Hist = { created: string | number; author?: { accountId?: string; name?: string; key?: string }; items: { field: string; fromString?: string | null; toString?: string | null; from?: string | null; to?: string | null }[] };

const ms = (s: string | number) => (typeof s === 'number' ? s : Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')));

/** Stable short pseudonym for a person id (demo data must not carry real names). */
export function pseudonym(id: string | undefined | null, salt = 'be'): string | undefined {
  if (!id) return undefined;
  let h = 2166136261;
  for (const ch of salt + id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 'p' + (h >>> 0).toString(36);
}

/** Issue from /search (v2 or v3) with expand=changelog, or an issue plus histories from changelog/bulkfetch. */
export function fromJiraIssue(issue: any, histories?: Hist[], opts: { anonymize?: boolean } = {}): IssueHistory {
  const f = issue.fields ?? {};
  const hs: Hist[] = histories ?? issue.changelog?.histories ?? [];
  const who = (a?: Hist['author']) => {
    const id = a?.accountId ?? a?.key ?? a?.name;
    return opts.anonymize ? pseudonym(id) : id;
  };
  const statusChanges = [] as IssueHistory['statusChanges'];
  const assigneeChanges = [] as IssueHistory['assigneeChanges'];
  for (const h of hs)
    for (const it of h.items) {
      if (it.field === 'status') statusChanges.push({ at: ms(h.created), from: it.fromString ?? '', to: it.toString ?? '', author: who(h.author) });
      if (it.field === 'assignee') {
        const fromId = it.from ?? it.fromString ?? undefined;
        const toId = it.to ?? it.toString ?? undefined;
        assigneeChanges.push({ at: ms(h.created), from: opts.anonymize ? pseudonym(fromId) : fromId ?? undefined, to: opts.anonymize ? pseudonym(toId) : toId ?? undefined });
      }
    }
  statusChanges.sort((a, b) => a.at - b.at);
  return {
    key: issue.key,
    type: f.issuetype?.name ?? 'Issue',
    priority: f.priority?.name,
    created: ms(f.created),
    resolved: f.resolutiondate ? ms(f.resolutiondate) : undefined,
    resolution: f.resolution?.name,
    initialStatus: statusChanges[0]?.from || f.status?.name || 'Open',
    statusChanges,
    assigneeChanges,
  };
}
