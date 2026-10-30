import type { ProposedAction } from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';

export const METRICS_ASSUMPTION =
  'Assumes 25 minutes of CSM time saved for each at-risk or critical client assessed (health review and a note).';

const MINUTES_PER_ACCOUNT = 25;
const BANDS = ['healthy', 'watch', 'at_risk', 'critical'] as const;

export interface MetricsSummary {
  accountsAssessed: number;
  atRiskProposals: number;
  atRiskAccounts: number;
  byState: Record<string, number>;
  autoCommitRate: number | null;
  approvalRate: number | null;
  medianApprovalMs: number | null;
  minutesSaved: number;
}

export function buildMetrics(
  proposals: ProposedAction[],
  approvedAt: Map<string, string>,
  portal: PortalConfig,
): MetricsSummary {
  const accounts = new Set(proposals.map((proposal) => accountKey(proposal)));
  const atRisk = proposals.filter((proposal) => isAtRiskProposal(proposal, portal));
  const atRiskAccounts = new Set(atRisk.map((proposal) => accountKey(proposal)));
  const byState: Record<string, number> = {};
  for (const proposal of proposals) byState[proposal.state] = (byState[proposal.state] ?? 0) + 1;

  const autos = proposals.filter((proposal) => proposal.policy_decision.effect === 'auto' && proposal.state !== 'superseded');
  const autoCommitted = autos.filter((proposal) => proposal.state === 'committed').length;
  const human = proposals.filter((proposal) => proposal.policy_decision.effect !== 'auto' && proposal.state !== 'superseded');
  const humanDone = human.filter((proposal) => proposal.state === 'approved' || proposal.state === 'committed').length;

  const waits: number[] = [];
  for (const proposal of proposals) {
    const at = approvedAt.get(proposal.id);
    if (!at) continue;
    const ms = new Date(at).getTime() - new Date(proposal.created_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) waits.push(ms);
  }

  return {
    accountsAssessed: accounts.size,
    atRiskProposals: atRisk.length,
    atRiskAccounts: atRiskAccounts.size,
    byState,
    autoCommitRate: autos.length === 0 ? null : autoCommitted / autos.length,
    approvalRate: human.length === 0 ? null : humanDone / human.length,
    medianApprovalMs: median(waits),
    minutesSaved: atRiskAccounts.size * MINUTES_PER_ACCOUNT,
  };
}

export function isAtRiskProposal(proposal: ProposedAction, portal: PortalConfig): boolean {
  const band = payloadBand(proposal, portal) ?? reasonBand(proposal);
  if (band === 'at_risk' || band === 'critical') return true;
  return proposal.policy_decision.rule_id === 'critical_or_large_at_risk';
}

export function accountScore(
  proposals: ProposedAction[],
  portal: PortalConfig,
): { band?: string; score?: string } {
  const bandKey = portal.properties.company.health_band;
  const scoreKey = portal.properties.company.health_score;
  for (const proposal of proposals) {
    if (proposal.kind !== 'set_properties') continue;
    const properties = proposal.payload.properties;
    if (!properties || typeof properties !== 'object') continue;
    const record = properties as Record<string, unknown>;
    const band = asString(record[bandKey]);
    const score = asString(record[scoreKey]);
    if (band || score) return { band, score };
  }
  return {};
}

export function reasonBand(proposal: ProposedAction): string | undefined {
  const text = proposal.reasons.map((reason) => reason.text).join(' ');
  return text.match(/\b(healthy|watch|at_risk|critical)\b/)?.[1];
}

function payloadBand(proposal: ProposedAction, portal: PortalConfig): string | undefined {
  const fromScore = accountScore([proposal], portal).band;
  if (fromScore && (BANDS as readonly string[]).includes(fromScore)) return fromScore;
  if (typeof proposal.payload.band === 'string' && (BANDS as readonly string[]).includes(proposal.payload.band)) {
    return proposal.payload.band;
  }
  return undefined;
}

function accountKey(proposal: ProposedAction): string {
  return `${proposal.account_ref.object}:${proposal.account_ref.id}`;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
