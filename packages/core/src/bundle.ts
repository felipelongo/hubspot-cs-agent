import { z } from 'zod';
import { canonicalJson, sha256 } from './hash.js';
import type { RecordRef } from './refs.js';

export const HealthBandSchema = z.enum(['healthy', 'watch', 'at_risk', 'critical']);
export type HealthBand = z.infer<typeof HealthBandSchema>;

export interface CompanySnapshot {
  ref: RecordRef;
  name: string;
  domain: string;
  industry: string | null;
  employees: number | null;
  plan: string | null;
  arr: number | null;
  seats_purchased: number | null;
  seats_active: number | null;
  last_login_at: string | null;
  owner_id: string | null;
  seed_csm: string | null;
  external_id: string | null;
  properties: Record<string, string | null>;
}

export interface ContactSnapshot {
  ref: RecordRef;
  name: string;
  email: string;
  role: 'champion' | 'economic_buyer' | 'admin' | 'end_user' | 'other';
  left_company: boolean;
  properties: Record<string, string | null>;
}

export interface DealSnapshot {
  ref: RecordRef;
  name: string;
  amount: number | null;
  close_date: string | null;
  stage: string | null;
  pipeline: string | null;
  is_renewal: boolean;
  stage_regressed: boolean;
  outcome: 'open' | 'won' | 'lost';
  properties: Record<string, string | null>;
}

export interface TicketSnapshot {
  ref: RecordRef;
  subject: string;
  body: string;
  priority: 'high' | 'medium' | 'low' | 'unknown';
  created_at: string | null;
  is_open: boolean;
  properties: Record<string, string | null>;
}

export interface ActivitySnapshot {
  ref: RecordRef;
  kind: 'note' | 'email' | 'meeting' | 'call';
  occurred_at: string;
  title: string;
  body: string;
  direction: 'inbound' | 'outbound' | 'replied' | 'bounced' | null;
  meeting_start: string | null;
  properties: Record<string, string | null>;
}

export interface OwnerSnapshot {
  id: string;
  email: string;
  name: string;
}

/** Everything the agent is allowed to see about one customer, with record ids. */
export interface AccountBundle {
  company: CompanySnapshot;
  contacts: ContactSnapshot[];
  deals: DealSnapshot[];
  renewal_deal: DealSnapshot | null;
  tickets: TicketSnapshot[];
  activities: ActivitySnapshot[];
  owner: OwnerSnapshot | null;
  window_days: number;
  assembled_at: string;
  bundle_hash: string;
}

export function withBundleHash(input: Omit<AccountBundle, 'bundle_hash'>): AccountBundle {
  return { ...input, bundle_hash: sha256(canonicalJson(input)) };
}

export function collectBundleRefs(bundle: AccountBundle): RecordRef[] {
  const refs: RecordRef[] = [bundle.company.ref];
  for (const contact of bundle.contacts) refs.push(contact.ref);
  for (const deal of bundle.deals) refs.push(deal.ref);
  for (const ticket of bundle.tickets) refs.push(ticket.ref);
  for (const activity of bundle.activities) refs.push(activity.ref);
  return refs;
}
