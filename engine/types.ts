// Core data model for Bottleneck Economist. Pure data, no Forge/Jira dependencies.

/** How a status behaves in the flow. */
export type StatusKind = 'queue' | 'active' | 'done';

export interface StatusChange {
  at: number; // epoch ms
  from: string;
  to: string;
  author?: string;
}

export interface AssigneeChange {
  at: number;
  from?: string;
  to?: string;
}

/** One issue reduced to what flow analysis needs. Assignee/author ids are opaque (hash them for demo data). */
export interface IssueHistory {
  key: string;
  type: string;
  priority?: string;
  created: number;
  resolved?: number;
  resolution?: string;
  initialStatus: string;
  statusChanges: StatusChange[];
  assigneeChanges: AssigneeChange[];
}

/** Continuous stay of an issue in one status. */
export interface Segment {
  issue: string;
  status: string;
  kind: StatusKind;
  start: number;
  end: number; // for unfinished segments = analysis end
  open: boolean; // still in this status at analysis end
}

export interface StatusConfig {
  /** Explicit kind per status name (case-insensitive). Overrides the heuristics. */
  kinds?: Record<string, StatusKind>;
  /** Order of statuses in the happy path (optional, improves the flow diagram). */
  order?: string[];
}

export interface MoneyAssumptions {
  hourlyCost: number; // loaded cost per person-hour
  valuePerItem: number; // value delivered by one finished item (revenue, saved cost...)
  costOfDelayPerItemWeek: number; // value lost per item per week of waiting
  hoursPerWeek: number; // productive hours per person per week
  currency: string;
}

export const DEFAULT_MONEY: MoneyAssumptions = {
  hourlyCost: 60,
  valuePerItem: 2000,
  costOfDelayPerItemWeek: 150,
  hoursPerWeek: 30,
  currency: 'EUR',
};

export interface AnalysisWindow {
  from: number;
  to: number;
}

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
