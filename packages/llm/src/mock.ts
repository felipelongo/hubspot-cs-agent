import type { LlmGenerateInput, LlmGenerateResult, LlmMessage, LlmPort } from '@cs-agent/core';

/**
 * Deterministic stand-in for the model.
 * It reads the JSON inside <customer_data> and ignores instructions written in notes.
 * cost_usd is 0 and model is "mock". This path does not call an API, so the run did not spend.
 */
export function createMockLlm(): LlmPort {
  return {
    async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
      const data = readCustomerData(input.messages);
      const allowed = collectRefs(data);
      return {
        output: mockOutput(input.schema_name, data, allowed),
        usage: { input_tokens: 0, output_tokens: 0 },
        cost_usd: 0,
        model: 'mock',
        latency_ms: 0,
        tool_calls: [],
      };
    },
  };
}

interface Evidence {
  object?: string;
  id?: string;
}

interface CustomerData {
  as_of?: string;
  bundle?: {
    company?: { name?: string; ref?: Evidence };
    owner?: { name?: string } | null;
    activities?: { body?: string; ref?: Evidence }[];
  };
  score?: {
    score?: number;
    band?: string;
    contributions?: { label?: string; evidence?: Evidence[]; signal_keys?: string[] }[];
  };
}

function mockOutput(schema: LlmGenerateInput['schema_name'], data: CustomerData, allowed: Set<string>): unknown {
  if (schema === 'RiskAssessment') return riskAssessment(data, allowed);
  if (schema === 'OutreachDraft') return outreachDraft(data, allowed);
  if (schema === 'CommitmentExtract') return commitmentExtract(data);
  if (schema === 'QsrPrep') return qsrPrep(data, allowed);
  return escalationBrief(data, allowed);
}

function riskAssessment(data: CustomerData, allowed: Set<string>): unknown {
  const band = data.score?.band || 'watch';
  const company = companyRef(data);
  const contributions = data.score?.contributions ?? [];
  const reasons =
    contributions.length > 0
      ? contributions.map((contribution) => ({
          text: contribution.label || `Score contribution for the ${band} band.`,
          citations: citationsFrom(contribution.evidence, company, allowed),
          signal_keys: contribution.signal_keys ?? [],
        }))
      : [
          {
            text: `The score band is ${band}.`,
            citations: citationsFrom(undefined, company, allowed),
            signal_keys: [],
          },
        ];
  const recommended = [
    {
      kind: 'set_properties',
      rationale: `Store the ${band} band on the company.`,
      citations: citationsFrom(undefined, company, allowed),
    },
  ];
  if (band === 'at_risk' || band === 'critical') {
    recommended.push({
      kind: 'create_task',
      rationale: `Ask the owner to review this ${band} account.`,
      citations: citationsFrom(undefined, company, allowed),
    });
  }
  if (band === 'critical') {
    recommended.push({
      kind: 'escalate',
      rationale: `The band is ${band}, so the CS lead should see it.`,
      citations: citationsFrom(undefined, company, allowed),
    });
  }
  return {
    summary: `The score band is ${band}.`,
    needs_review: false,
    reasons,
    recommended_actions: recommended,
  };
}

function outreachDraft(data: CustomerData, allowed: Set<string>): unknown {
  const name = data.bundle?.company?.name || 'this account';
  const band = data.score?.band || 'watch';
  const company = companyRef(data);
  return {
    subject: `${name} renewal (${band})`,
    body: [
      `Hello,`,
      ``,
      `I am checking in on ${name}. The health band on this account is ${band}.`,
      `I would like to compare notes before the renewal.`,
      ``,
      `The account team`,
    ].join('\n'),
    reasons: [
      {
        text: `${name} is in the ${band} band.`,
        citations: citationsFrom(undefined, company, allowed),
      },
    ],
  };
}

function commitmentExtract(data: CustomerData): unknown {
  const asOf = asOfDay(data);
  const owner = data.bundle?.owner?.name || 'account team';
  const commitments = [];
  for (const activity of data.bundle?.activities ?? []) {
    const citation = formatEvidence(activity.ref);
    if (!citation || !activity.body) continue;
    for (const found of findPromises(activity.body)) {
      commitments.push({
        text: found.text,
        owner,
        due_date: found.due,
        overdue: found.due < asOf,
        citations: [citation],
      });
    }
  }
  return { commitments };
}

function qsrPrep(data: CustomerData, allowed: Set<string>): unknown {
  const name = data.bundle?.company?.name || 'This account';
  const company = citationsFrom(undefined, companyRef(data), allowed);
  return {
    experimental: true,
    headline: `${name} quarterly review`,
    sections: [
      {
        title: 'Account',
        bullets: [{ text: `${name} quarterly success review outline.`, citations: company }],
      },
    ],
  };
}

function escalationBrief(data: CustomerData, allowed: Set<string>): unknown {
  const name = data.bundle?.company?.name || 'This account';
  const band = data.score?.band || 'watch';
  const top = data.score?.contributions?.[0];
  const citations = citationsFrom(top?.evidence, companyRef(data), allowed);
  return {
    lines: [
      `${name} is in the ${band} band.`,
      `The health score is ${data.score?.score ?? 'unknown'}.`,
      top?.label ? `Main driver: ${top.label}.` : 'No scored driver was attached.',
      'The brief uses only the records in the bundle.',
      'Please decide whether a person should step in.',
    ],
    citations,
  };
}

function findPromises(body: string): { text: string; due: string }[] {
  const found: { text: string; due: string }[] = [];
  const patterns = [/we promised (.+?) by (\d{4}-\d{2}-\d{2})/gi, /we will (.+?) by (\d{4}-\d{2}-\d{2})/gi];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const text = match[1]?.trim();
      const due = match[2];
      if (text && due) found.push({ text, due });
    }
  }
  return found;
}

function asOfDay(data: CustomerData): string {
  if (typeof data.as_of === 'string' && data.as_of.length >= 10) return data.as_of.slice(0, 10);
  return '2026-10-30';
}

function companyRef(data: CustomerData): string | null {
  return formatEvidence(data.bundle?.company?.ref);
}

function formatEvidence(value: Evidence | undefined): string | null {
  if (!value?.object || !value.id) return null;
  return `hubspot:${value.object}:${value.id}`;
}

function citationsFrom(evidence: Evidence[] | undefined, company: string | null, allowed: Set<string>): string[] {
  const cited = (evidence ?? [])
    .map((item) => formatEvidence(item))
    .filter((item): item is string => item != null && allowed.has(item));
  if (cited.length > 0) return cited;
  if (company && allowed.has(company)) return [company];
  const first = [...allowed][0];
  if (first) return [first];
  return company ? [company] : ['hubspot:company:missing'];
}

function readCustomerData(messages: LlmMessage[]): CustomerData {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const match = message.content.match(/<customer_data>\s*([\s\S]*?)\s*<\/customer_data>/);
    if (!match) continue;
    const raw = unwrapFence(match[1] ?? '');
    try {
      return JSON.parse(raw) as CustomerData;
    } catch {
      return {};
    }
  }
  return {};
}

function unwrapFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? (fenced[1] ?? '').trim() : trimmed;
}

/** Every hubspot ref that is actually present in the payload. */
function collectRefs(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.object === 'string' && typeof record.id === 'string') {
      found.add(`hubspot:${record.object}:${record.id}`);
    }
    for (const child of Object.values(record)) collectRefs(child, found);
  }
  return found;
}
