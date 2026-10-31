import type { StatusConfig, StatusKind } from './types.js';

const DONE = /^(done|closed|resolved|released|complete(d)?|cancel(l)?ed|won'?t (do|fix)|deployed|shipped)$/i;
// Statuses where the work item waits for someone (a queue), even if Jira puts them in the "In Progress" category.
const QUEUE = /(to ?do|backlog|open|new|triage|selected|ready|awaiting|waiting|pending|on hold|blocked|needs?|patch available|queued|requested|reopened|in review queue|review requested|approval)/i;
const ACTIVE = /(in progress|progress|doing|develop|implement|coding|review in progress|reviewing|testing|in test|qa|verif|analys|design|writing|working|changes suggested)/i;

/**
 * Classify a status name. Explicit config wins; then done-words; then active-words; then queue-words.
 * "Review In Progress" is active; "Ready for review" / "Patch Available" is a queue.
 */
export function statusKind(name: string, cfg?: StatusConfig): StatusKind {
  const explicit = cfg?.kinds && Object.entries(cfg.kinds).find(([k]) => k.toLowerCase() === name.toLowerCase());
  if (explicit) return explicit[1];
  if (DONE.test(name.trim())) return 'done';
  if (/^ready to (commit|merge|deploy|release)$/i.test(name)) return 'queue';
  if (ACTIVE.test(name) && !/^(ready|awaiting|waiting|needs?)/i.test(name)) return 'active';
  if (QUEUE.test(name)) return 'queue';
  return 'active';
}
