import { formatRef, type ApprovalRecord, type CommitRecord, type ProposedAction, type RecordRef, type RunRecord } from '@cs-agent/core';
import type { PortalConfig } from '@cs-agent/config';
import { bandPill, escapeHtml, flash, page } from './html.js';
import { METRICS_ASSUMPTION, type MetricsSummary } from './metrics.js';

const OBJECT_TYPE_IDS: Record<RecordRef['object'], string> = {
  company: '0-2',
  contact: '0-1',
  deal: '0-3',
  ticket: '0-5',
  note: '0-46',
  email: '0-49',
  meeting: '0-47',
  call: '0-48',
  task: '0-27',
};

export interface QueueGroup {
  accountId: string;
  name: string;
  band?: string;
  score?: string;
  rows: ProposedAction[];
}

export function loginDocument(password: string, error?: string): string {
  const hint = password === 'demo' ? '<p class="lead">Demo password: demo</p>' : '<p class="lead">Enter the console password.</p>';
  const body = `${flash(error)}
    ${hint}
    <form class="card" method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
      <p><button type="submit">Sign in</button></p>
    </form>`;
  return page('Sign in', body, false);
}

export function queueDocument(groups: QueueGroup[], now: Date, error?: string): string {
  const body = `${flash(error)}
    <p class="lead">Proposals waiting for a person. Grouped by account.</p>
    ${groups.length === 0 ? '<div class="card"><p>No proposals are waiting.</p></div>' : groups.map((group) => renderGroup(group, now)).join('')}`;
  return page('Queue', body, true);
}

export function proposalDocument(input: {
  proposal: ProposedAction;
  portal: PortalConfig;
  accountName: string;
  approval: ApprovalRecord | null;
  hubspotAccountId: string | undefined;
  error?: string;
  notice?: string;
}): string {
  const { proposal } = input;
  const hashMismatch =
    input.approval && input.approval.action_hash !== proposal.action_hash
      ? '<p class="error">This approval hash does not match the proposal.</p>'
      : '';
  const body = `${flash(input.error, input.notice)}
    <p class="lead">${escapeHtml(input.accountName)} · ${escapeHtml(proposal.kind.replaceAll('_', ' '))} · <span class="state">${escapeHtml(proposal.state)}</span></p>
    <div class="card">
      <p><strong>Procedure</strong> ${escapeHtml(proposal.procedure)}</p>
      <p><strong>Policy rule</strong> ${escapeHtml(proposal.policy_decision.rule_id)} (${escapeHtml(proposal.policy_decision.effect)})</p>
      <p><strong>Action hash</strong><br /><code>${escapeHtml(proposal.action_hash)}</code></p>
      <p><strong>Idempotency key</strong><br /><code>${escapeHtml(proposal.idempotency_key)}</code></p>
      ${proposal.supersedes_id ? `<p><strong>Supersedes</strong> <a href="/proposals/${escapeHtml(proposal.supersedes_id)}">${escapeHtml(proposal.supersedes_id)}</a></p>` : ''}
    </div>
    <h2>Reasons</h2>
    ${proposal.reasons.map((reason) => `<div class="card"><p>${escapeHtml(reason.text)}</p><p>${renderCitations(reason.citations, input.portal, input.hubspotAccountId)}</p></div>`).join('') || '<p class="muted">No reasons.</p>'}
    ${hashMismatch}
    ${input.approval ? `<div class="card"><p><strong>${escapeHtml(input.approval.decision)}</strong> by ${escapeHtml(input.approval.approver)} at ${escapeHtml(input.approval.at)}</p><p>Recorded hash <code>${escapeHtml(input.approval.action_hash)}</code></p>${input.approval.comment ? `<p>${escapeHtml(input.approval.comment)}</p>` : ''}</div>` : ''}
    <h2>Payload</h2>
    <pre>${escapeHtml(JSON.stringify(proposal.payload, null, 2))}</pre>
    ${renderForms(proposal)}`;
  return page('Proposal', body, true);
}

export function runsDocument(runs: RunRecord[]): string {
  const rows = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
  const table =
    rows.length === 0
      ? '<p>No runs yet.</p>'
      : `<div class="scroll"><table>
          <thead><tr><th>Workflow</th><th>Mode</th><th>Status</th><th>Started</th><th>Accounts</th><th>Proposals</th><th>Commits</th><th>Cost</th></tr></thead>
          <tbody>${rows
            .map(
              (run) => `<tr>
                <td><a href="/runs/${escapeHtml(run.id)}">${escapeHtml(run.workflow)}</a></td>
                <td>${escapeHtml(run.mode)}</td>
                <td>${escapeHtml(run.status)}</td>
                <td>${escapeHtml(run.started_at)}</td>
                <td>${run.accounts_considered}</td>
                <td>${run.proposals_created}</td>
                <td>${run.commits}</td>
                <td>${run.cost_usd.toFixed(4)}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>`;
  return page('Runs', table, true);
}

export function runDocument(run: RunRecord, proposals: ProposedAction[], commits: CommitRecord[]): string {
  const body = `<div class="card">
      <p><strong>Status</strong> ${escapeHtml(run.status)} · ${escapeHtml(run.mode)}</p>
      <p><strong>Started</strong> ${escapeHtml(run.started_at)}</p>
      <p><strong>Finished</strong> ${escapeHtml(run.finished_at ?? 'still running')}</p>
      <p><strong>Accounts</strong> ${run.accounts_considered} · <strong>Proposals</strong> ${run.proposals_created} · <strong>Commits</strong> ${run.commits}</p>
      <p><strong>Cost</strong> $${run.cost_usd.toFixed(4)}</p>
      ${run.error ? `<p class="error">${escapeHtml(run.error)}</p>` : ''}
    </div>
    <h2>Proposals</h2>
    ${proposalTable(proposals)}
    <h2>Commits</h2>
    ${
      commits.length === 0
        ? '<p class="muted">No commits recorded for this run.</p>'
        : `<div class="scroll"><table><thead><tr><th>When</th><th>Proposal</th><th>Outcome</th><th>HubSpot ids</th></tr></thead><tbody>${commits
            .map(
              (commit) => `<tr><td>${escapeHtml(commit.at)}</td><td><a href="/proposals/${escapeHtml(commit.proposal_id)}">${escapeHtml(commit.proposal_id)}</a></td><td>${escapeHtml(commit.outcome)}</td><td>${escapeHtml(commit.hubspot_ids.join(', ') || '—')}</td></tr>`,
            )
            .join('')}</tbody></table></div>`
    }`;
  return page(run.workflow, body, true);
}

export function auditDocument(rows: { at: string; actor: string; action: string; entity: string }[], query: string): string {
  const shown = rows.slice(0, 40);
  const note =
    rows.length > shown.length
      ? `<p class="muted">Showing the latest ${shown.length} of ${rows.length}. The log keeps every row. Filter to narrow it.</p>`
      : `<p class="muted">${rows.length} row${rows.length === 1 ? '' : 's'}. This log is append-only.</p>`;
  const body = `<form method="get" action="/audit">
      <label for="q">Filter by action or entity</label>
      <input id="q" name="q" type="text" value="${escapeHtml(query)}" />
      <p><button type="submit">Filter</button></p>
    </form>
    ${note}
    ${
      shown.length === 0
        ? '<p>No audit rows match.</p>'
        : `<table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>${shown
            .map(
              (row) => `<tr><td>${escapeHtml(row.at)}</td><td>${escapeHtml(row.actor)}</td><td>${escapeHtml(row.action)}</td><td><a href="/proposals/${escapeHtml(row.entity)}">${escapeHtml(row.entity)}</a></td></tr>`,
            )
            .join('')}</tbody></table>`
    }`;
  return page('Audit', body, true);
}

export function metricsDocument(summary: MetricsSummary): string {
  const states = Object.entries(summary.byState)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => `<tr><td>${escapeHtml(state)}</td><td>${count}</td></tr>`)
    .join('');
  const hours = (summary.minutesSaved / 60).toFixed(2);
  const body = `<div class="card">
      <p><strong>Accounts assessed</strong> ${summary.accountsAssessed}</p>
      <p><strong>At-risk found</strong> ${summary.atRiskProposals} proposals across ${summary.atRiskAccounts} accounts</p>
      <p><strong>Auto-commit rate</strong> ${percent(summary.autoCommitRate)}</p>
      <p><strong>Approval rate</strong> ${percent(summary.approvalRate)}</p>
      <p><strong>Median time to approval</strong> ${summary.medianApprovalMs == null ? 'n/a' : formatDuration(summary.medianApprovalMs)}</p>
      <p><strong>Estimated CSM hours saved</strong> ${hours} (${summary.minutesSaved} minutes)</p>
    </div>
    <h2>Proposals by state</h2>
    <div class="scroll"><table><thead><tr><th>State</th><th>Count</th></tr></thead><tbody>${states || '<tr><td colspan="2">No proposals.</td></tr>'}</tbody></table></div>
    <p class="muted">${escapeHtml(METRICS_ASSUMPTION)}</p>
    <p class="muted">Auto-commit rate is committed auto proposals divided by auto proposals that are not superseded. Approval rate is approved or committed human-gated proposals divided by human-gated proposals that are not superseded.</p>`;
  return page('Metrics', body, true);
}

export function notFoundDocument(): string {
  return page('Not found', '<p>That page is not in the console.</p>', true);
}

function renderGroup(group: QueueGroup, now: Date): string {
  const rows = group.rows
    .map(
      (proposal) => `<tr>
        <td><a href="/proposals/${escapeHtml(proposal.id)}">${escapeHtml(proposal.kind.replaceAll('_', ' '))}</a></td>
        <td>${escapeHtml(proposal.state.replaceAll('_', ' '))}</td>
        <td>${escapeHtml(age(proposal.created_at, now))}</td>
      </tr>`,
    )
    .join('');
  return `<section class="card">
      <h2>${escapeHtml(group.name)} ${bandPill(group.band)} ${group.score ? `<span class="muted">score ${escapeHtml(group.score)}</span>` : ''}</h2>
      <div class="scroll"><table><thead><tr><th>Kind</th><th>State</th><th>Age</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
}

function proposalTable(proposals: ProposedAction[]): string {
  if (proposals.length === 0) return '<p class="muted">No proposals.</p>';
  return `<div class="scroll"><table><thead><tr><th>Kind</th><th>State</th><th>Account</th></tr></thead><tbody>${proposals
    .map(
      (proposal) => `<tr><td><a href="/proposals/${escapeHtml(proposal.id)}">${escapeHtml(proposal.kind)}</a></td><td>${escapeHtml(proposal.state)}</td><td>${escapeHtml(proposal.account_ref.id)}</td></tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function renderForms(proposal: ProposedAction): string {
  const waiting = proposal.state === 'awaiting_approval' || proposal.state === 'escalated';
  const committable = proposal.state === 'approved' || proposal.state === 'auto_approved';
  if (!waiting && !committable) return '';
  const approve = waiting
    ? `<form method="post" action="/proposals/${escapeHtml(proposal.id)}/approve">
        <input type="hidden" name="mode" value="live" />
        <button type="submit">Approve</button>
        <p class="muted">Approving commits when this form is live, or when MODE is live.</p>
      </form>
      <form method="post" action="/proposals/${escapeHtml(proposal.id)}/reject">
        <label for="comment">Reject reason</label>
        <input id="comment" name="comment" type="text" />
        <p><button class="danger" type="submit">Reject</button></p>
      </form>`
    : '';
  const commit = committable
    ? `<form method="post" action="/proposals/${escapeHtml(proposal.id)}/commit">
        <input type="hidden" name="mode" value="live" />
        <button type="submit">Commit</button>
      </form>`
    : '';
  const edit = waiting
    ? `<form method="post" action="/proposals/${escapeHtml(proposal.id)}/edit">
        <label for="payload">Edit payload</label>
        <textarea id="payload" name="payload" spellcheck="false">${escapeHtml(JSON.stringify(proposal.payload, null, 2))}</textarea>
        <label for="edit-comment">Comment</label>
        <input id="edit-comment" name="comment" type="text" />
        <p><button class="quiet" type="submit">Save edit</button></p>
      </form>`
    : '';
  return `<h2>Decision</h2><div class="actions">${approve}${commit}</div>${edit}`;
}

function renderCitations(citations: RecordRef[], portal: PortalConfig, accountId: string | undefined): string {
  if (citations.length === 0) return '<span class="muted">No citation.</span>';
  return citations
    .map((citation) => {
      const text = formatRef(citation);
      const href = recordHref(portal, accountId, citation);
      const link = href ? ` <a href="${escapeHtml(href)}" rel="noreferrer">open</a>` : '';
      return `<code>${escapeHtml(text)}</code>${link}`;
    })
    .join(', ');
}

function recordHref(portal: PortalConfig, accountId: string | undefined, citation: RecordRef): string | null {
  if (!accountId) return null;
  const url = portal.console.record_url_template
    .replaceAll('{accountId}', encodeURIComponent(accountId))
    .replaceAll('{objectTypeId}', OBJECT_TYPE_IDS[citation.object])
    .replaceAll('{id}', encodeURIComponent(citation.id));
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  return null;
}

function age(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function percent(value: number | null): string {
  if (value == null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}
