import type { ProposedAction, RunMode } from './action.js';
import type { OutputSchemaName } from './outputs.js';
import type { ObjectType, RecordRef } from './refs.js';

/**
 * Read side of HubSpot.
 * The agent runner may receive only this. It has no create, update, or upsert.
 * Search lags behind writes. Never use search to confirm something you just wrote.
 */
export interface CrmRecord {
  ref: RecordRef;
  properties: Record<string, string | null>;
}

export interface SearchFilter {
  property: string;
  operator: 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE' | 'CONTAINS_TOKEN' | 'HAS_PROPERTY' | 'NOT_HAS_PROPERTY' | 'IN';
  value?: string;
  /** HubSpot IN accepts at most 100 values. */
  values?: string[];
}

export interface SearchRequest {
  filters?: SearchFilter[];
  query?: string;
  properties?: string[];
  limit?: number;
  after?: string;
  sorts?: { property: string; direction: 'ASCENDING' | 'DESCENDING' }[];
}

export interface SearchPage {
  results: CrmRecord[];
  after?: string;
}

export interface PropertyDefinition {
  name: string;
  label: string;
  type: 'string' | 'number' | 'datetime' | 'date' | 'enumeration' | 'bool';
  fieldType: string;
  groupName: string;
  description?: string;
  options?: { label: string; value: string }[];
  /** Required for batch upsert id properties. Engagements often reject this. */
  hasUniqueValue?: boolean;
}

export interface HubSpotOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface PipelineStage {
  id: string;
  label: string;
}

export interface Pipeline {
  id: string;
  label: string;
  stages: PipelineStage[];
}

export interface HubSpotReadPort {
  getRecord(record: RecordRef, properties?: string[]): Promise<CrmRecord | null>;
  batchRead(object: ObjectType, ids: string[], properties?: string[]): Promise<CrmRecord[]>;
  search(object: ObjectType, request: SearchRequest): Promise<SearchPage>;
  listAssociations(from: RecordRef, to: ObjectType): Promise<RecordRef[]>;
  listProperties(object: ObjectType): Promise<PropertyDefinition[]>;
  getProperty(object: ObjectType, name: string): Promise<PropertyDefinition | null>;
  listOwners(): Promise<HubSpotOwner[]>;
  listPipelines(object: 'deal' | 'ticket'): Promise<Pipeline[]>;
  /** Look through the company's notes and tasks for an exact idempotency marker. Do not use search. */
  findMarker(companyId: string, marker: string): Promise<RecordRef[]>;
}

export interface ObjectWrite {
  properties: Record<string, string>;
  associations?: { to: RecordRef }[];
}

export interface UpsertInput {
  idProperty: string;
  id: string;
  properties: Record<string, string>;
}

/** Write side. Setup, seed, and commit may use this. The model never sees it. */
export interface HubSpotWritePort {
  createRecord(object: ObjectType, write: ObjectWrite): Promise<CrmRecord>;
  updateRecord(record: RecordRef, properties: Record<string, string>): Promise<CrmRecord>;
  batchUpsert(object: ObjectType, rows: UpsertInput[]): Promise<CrmRecord[]>;
  associate(from: RecordRef, to: RecordRef): Promise<void>;
  archive(record: RecordRef): Promise<void>;
  createPropertyGroup(object: ObjectType, group: { name: string; label: string }): Promise<{ created: boolean }>;
  createProperty(object: ObjectType, property: PropertyDefinition): Promise<{ created: boolean }>;
  ensurePipeline(
    object: 'deal' | 'ticket',
    spec: { label: string; stages: { label: string }[] },
  ): Promise<{ pipelineId: string; created: boolean; missingStages: string[] }>;
}

export interface HubSpotPort extends HubSpotReadPort, HubSpotWritePort {}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmToolCall {
  name: string;
  input: unknown;
}

export interface LlmGenerateInput {
  messages: LlmMessage[];
  schema_name: OutputSchemaName;
  tier: 'fast' | 'strong';
  max_steps?: number;
  on_tool?: (call: LlmToolCall) => Promise<unknown>;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface LlmGenerateResult {
  output: unknown;
  usage: LlmUsage;
  cost_usd: number;
  model: string;
  latency_ms: number;
  tool_calls: LlmToolCall[];
}

export interface LlmPort {
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  before: unknown;
  after: unknown;
}

export interface RunRecord {
  id: string;
  workflow: string;
  mode: RunMode;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'succeeded' | 'failed';
  accounts_considered: number;
  proposals_created: number;
  commits: number;
  cost_usd: number;
  error: string | null;
}

export interface CommitRecord {
  proposal_id: string;
  idempotency_key: string;
  outcome: 'committed' | 'replayed' | 'dry_run' | 'shadow_skipped';
  hubspot_ids: string[];
  request: unknown;
  response: unknown;
  at: string;
}

export interface ApprovalRecord {
  proposal_id: string;
  approver: string;
  decision: 'approved' | 'rejected';
  action_hash: string;
  comment: string | null;
  at: string;
}

export interface LlmCallRecord {
  id: string;
  run_id: string;
  procedure: string;
  model: string;
  tier: 'fast' | 'strong';
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  at: string;
}

export interface LedgerPort {
  migrate(): Promise<void>;
  startRun(input: { id: string; workflow: string; mode: RunMode; started_at: string }): Promise<void>;
  finishRun(
    id: string,
    patch: {
      status: 'succeeded' | 'failed';
      finished_at: string;
      accounts_considered: number;
      proposals_created: number;
      commits: number;
      cost_usd: number;
      error?: string;
    },
  ): Promise<void>;
  insertProposal(action: ProposedAction): Promise<void>;
  getProposal(id: string): Promise<ProposedAction | null>;
  listProposals(filter?: { state?: ProposedAction['state']; run_id?: string; account_id?: string }): Promise<ProposedAction[]>;
  findByIdempotency(key: string): Promise<ProposedAction | null>;
  transition(id: string, to: ProposedAction['state'], actor: string, reason?: string): Promise<ProposedAction>;
  recordApproval(input: ApprovalRecord): Promise<void>;
  latestApproval(proposalId: string): Promise<ApprovalRecord | null>;
  hasIdempotency(key: string): Promise<boolean>;
  recordCommit(input: CommitRecord): Promise<void>;
  listCommits(filter?: { run_id?: string }): Promise<CommitRecord[]>;
  appendAudit(entry: Omit<AuditEntry, 'id'> & { id?: string }): Promise<void>;
  listAudit(filter?: { entity?: string; limit?: number }): Promise<AuditEntry[]>;
  logLlmCall(call: LlmCallRecord): Promise<void>;
  listRuns(): Promise<RunRecord[]>;
  getRun(id: string): Promise<RunRecord | null>;
  /** Sum of llm cost for a run. */
  runCost(runId: string): Promise<number>;
}

export interface ApprovalRequest {
  proposal: ProposedAction;
  account_name: string;
}

export interface ApprovalPort {
  /** Tell a human that a proposal is waiting. The console lists the ledger; this can be a no-op. */
  notify(request: ApprovalRequest): Promise<void>;
}

/** Thrown when HubSpot's daily quota is spent. Callers stop the run. Do not retry. */
export class DailyRateLimitError extends Error {
  readonly code = 'daily_rate_limit';
  constructor(message = 'HubSpot daily rate limit is exhausted. This run stopped without retrying.') {
    super(message);
    this.name = 'DailyRateLimitError';
  }
}

/** In-memory shape of fixtures/seed.json. MockHubSpot loads this. It is not a HubSpot payload. */
export interface SeedDatabase {
  as_of: string;
  vendor: { name: string; product: string };
  owners: { id: string; email: string; first_name: string; last_name: string; role: 'csm' | 'cs_lead' }[];
  companies: { id: string; properties: Record<string, string> }[];
  contacts: { id: string; properties: Record<string, string> }[];
  deals: { id: string; properties: Record<string, string> }[];
  tickets: { id: string; properties: Record<string, string> }[];
  activities: { id: string; object: 'note' | 'email' | 'meeting' | 'call'; properties: Record<string, string> }[];
  associations: { from: RecordRef; to: RecordRef }[];
  history: HistoricalOutcome[];
}

export interface HistoricalOutcome {
  company_id: string;
  company_name: string;
  as_of: string;
  closed_at: string;
  outcome: 'won' | 'lost';
  signals: { key: string; value: number | string | boolean | null; evidence?: RecordRef[] }[];
}

export interface ExpectedAccount {
  company_id: string;
  name: string;
  archetype: string;
  expected_band: 'healthy' | 'watch' | 'at_risk' | 'critical';
  expected_signal_keys: string[];
  expect_escalation: boolean;
  expect_task: boolean;
  expect_needs_review: boolean;
  injection_probe: boolean;
}

export interface ExpectedFile {
  rules_version: string;
  accounts: ExpectedAccount[];
}
