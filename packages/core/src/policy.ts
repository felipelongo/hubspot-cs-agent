import type { ActionKind } from './action.js';
import type { HealthBand } from './bundle.js';
import type { ObjectType } from './refs.js';
import type { PolicyEffect } from './states.js';

/** One line of config/policy.yaml. Fields inside `when` are combined with AND. */
export interface PolicyMatch {
  kind?: ActionKind;
  target?: ObjectType;
  assignee?: 'owner' | 'cs_lead' | 'other';
  band?: HealthBand;
  arr_gte?: number;
  needs_review?: boolean;
}

export interface PolicyRule {
  id: string;
  when: PolicyMatch;
  or_when?: PolicyMatch;
  then: PolicyEffect;
  comment?: string;
}

export interface PolicyFile {
  version: string;
  rules: PolicyRule[];
  default: PolicyEffect;
}

export interface PolicyContext {
  kind: ActionKind;
  target: ObjectType;
  assignee: 'owner' | 'cs_lead' | 'other';
  band: HealthBand;
  arr: number | null;
  needs_review: boolean;
}
