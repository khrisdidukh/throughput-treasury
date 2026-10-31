// Pull a fresh rolling 12-month flow from a public Jira (default: Apache Cassandra) and run the engine on it.
// Read-only and polite: 100 issues per page, a pause between pages, people pseudonymised on the way in.
import { fromJiraIssue } from '../engine/jira.js';
import { computeFlow, type FlowSummary } from '../engine/metrics.js';
import type { IssueHistory, StatusConfig } from '../engine/types.js';

const BASE = process.env.JIRA_BASE || 'https://issues.apache.org/jira';
const FIELDS = 'status,created,resolutiondate,resolution,issuetype,priority';
export const CASSANDRA_CFG: StatusConfig = {
  order: ['Triage Needed', 'Open', 'In Progress', 'Patch Available', 'Review In Progress', 'Changes Suggested', 'Needs Committer', 'Ready to Commit', 'Resolved', 'Closed'],
  kinds: { 'Changes Suggested': 'queue', 'Awaiting Feedback': 'queue', 'Needs Reviewer': 'queue' },
};

async function get(url: string, tries = 5): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'throughput-treasury/0.1 (NEAR hackathon demo; read-only)' } });
      if (r.ok) return r.json();
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
    }
  }
}

export type LiveFlow = { flow: FlowSummary; source: string; project: string; fetched_at: string; issues: number };

export async function fetchLiveFlow(project = 'CASSANDRA', weeks = 52, log: (s: string) => void = () => {}): Promise<LiveFlow> {
  const to = Date.now();
  const from = to - weeks * 7 * 86_400_000;
  const jql = `project=${project} AND (resolution = Unresolved OR resolved >= -${weeks * 7}d) ORDER BY created ASC`;
  const issues: IssueHistory[] = [];
  let start = 0, total = Infinity;
  while (start < total) {
    const q = new URLSearchParams({ jql, startAt: String(start), maxResults: '100', expand: 'changelog', fields: FIELDS });
    const d = await get(`${BASE}/rest/api/2/search?${q}`);
    total = d.total;
    for (const issue of d.issues) {
      if (issue.changelog && issue.changelog.total > issue.changelog.histories.length) {
        const full = await get(`${BASE}/rest/api/2/issue/${issue.key}?expand=changelog&fields=status`);
        issue.changelog = full.changelog;
      }
      const i = fromJiraIssue(issue, undefined, { anonymize: true });
      if (i.created > to || (i.resolved && i.resolved < from)) continue;
      issues.push(i);
    }
    start += d.issues.length;
    log(`${project}: ${start}/${total}`);
    if (!d.issues.length) break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const flow = computeFlow(issues, { from, to }, project === 'CASSANDRA' ? CASSANDRA_CFG : undefined);
  const name = project === 'CASSANDRA' ? 'Apache Cassandra' : project;
  return { flow, project, issues: issues.length, fetched_at: new Date(to).toISOString(), source: `${name} (public Jira), ${flow.window.from} – ${flow.window.to}, fetched ${new Date(to).toISOString().slice(0, 16).replace('T', ' ')} UTC` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = Date.now();
  const r = await fetchLiveFlow(process.argv[2] || 'CASSANDRA', 52, console.log);
  console.log(r.source, r.issues, 'issues in', Math.round((Date.now() - t) / 1000), 's; JSON bytes', JSON.stringify(r).length);
  const { fromFlow } = await import('../engine/report.js');
  console.log(fromFlow('x', 'demo', r.flow).headline);
}
