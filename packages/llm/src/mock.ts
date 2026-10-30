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
  sender_first_name?: string;
  bundle?: {
    company?: {
      name?: string;
      ref?: Evidence;
      seats_active?: number | null;
      seats_purchased?: number | null;
      hot_leads_unworked?: number | null;
    };
    owner?: { name?: string } | null;
    contacts?: { name?: string; role?: string; left_company?: boolean }[];
    renewal_deal?: { close_date?: string | null } | null;
    activities?: { body?: string; ref?: Evidence }[];
  };
  signals?: { key?: string; value?: number | boolean | string | null; explanation?: string }[];
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
          text: reasonLine(contribution.label, contribution.signal_keys, data, band),
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

function reasonLine(
  label: string | undefined,
  keys: string[] | undefined,
  data: CustomerData,
  band: string,
): string {
  const base = label || `Score contribution for the ${band} band.`;
  if (!data.signals) return base;
  const extra = (keys ?? [])
    .map((key) => data.signals?.find((signal) => signal.key === key)?.explanation)
    .filter((item): item is string => Boolean(item))
    .join(' ');
  return extra ? `${base} ${extra}` : base;
}

function outreachDraft(data: CustomerData, allowed: Set<string>): unknown {
  const name = data.bundle?.company?.name || 'your team';
  const first = senderFirstName(data);
  const company = companyRef(data);
  const month = renewalMonth(data.bundle?.renewal_deal?.close_date);
  const when = month
    ? `I am writing ahead of your ${month} renewal so we can talk through the next year before that date arrives.`
    : `I am writing ahead of your renewal so we can talk through the next year before the date arrives.`;
  const departed = data.bundle?.contacts?.find((contact) => contact.role === 'development_director' && contact.left_company);
  const noticed = data.signals?.find((signal) => signal.key === 'champion_left' && signal.value === true);
  const director = data.bundle?.contacts?.find((contact) => contact.role === 'executive_director' && contact.name);
  const unworked = data.bundle?.company?.hot_leads_unworked;
  let fact = seatFact(data) ?? `It has been good to work with the development team at ${name}.`;
  let hello = 'Hello,';
  if ((departed || noticed) && director?.name && typeof unworked === 'number') {
    hello = `Hello ${director.name},`;
    const who = departed?.name ? `${departed.name}'s mailbox came back unavailable, so I am writing to you.` : 'I am writing to you because the development director is no longer there.';
    fact = `${who} Could you tell me who now leads major gifts? I would like to walk through the ${unworked} waiting supporters who are ready to give.`;
  }
  const lines = [
    hello,
    '',
    `I hope you are doing well at ${name}. ${fact} ${when} Would you have 20 minutes for a call? You can choose a time here: [booking link]. If I have the wrong person, please tell me who the right contact is.`,
    '',
    'Thank you,',
  ];
  if (first) lines.push(first);
  return {
    subject: 'Planning ahead for your renewal',
    body: lines.join('\n'),
    reasons: [
      {
        text: `${name} has a renewal to plan.`,
        citations: citationsFrom(undefined, company, allowed),
      },
    ],
  };
}

function senderFirstName(data: CustomerData): string | null {
  const explicit = data.sender_first_name?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const owner = data.bundle?.owner?.name?.trim().split(/\s+/)[0];
  return owner || null;
}

function seatFact(data: CustomerData): string | null {
  const active = data.bundle?.company?.seats_active;
  const purchased = data.bundle?.company?.seats_purchased;
  if (typeof active !== 'number' || typeof purchased !== 'number') return null;
  if (purchased <= 0 || active <= 0) return null;
  return `${active} of your ${purchased} seats are active, and it is good to see the team in the product.`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function renewalMonth(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (!match?.[2]) return null;
  return MONTHS[Number(match[2]) - 1] ?? null;
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
        owner: found.side === 'customer' ? 'customer' : owner,
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
    headline: `${name} quarterly ROI review`,
    sections: [
      {
        title: 'Gifts and leads',
        bullets: [
          {
            text: `${name}: leads delivered, followed up, gifts attributed, and pace versus the guarantee.`,
            citations: company,
          },
        ],
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

function findPromises(body: string): { text: string; due: string; side: 'us' | 'customer' }[] {
  const found: { text: string; due: string; side: 'us' | 'customer' }[] = [];
  const patterns: { pattern: RegExp; side: 'us' | 'customer' }[] = [
    { pattern: /we promised (.+?) by (\d{4}-\d{2}-\d{2})/gi, side: 'us' },
    { pattern: /we'll (.+?) by (\d{4}-\d{2}-\d{2})/gi, side: 'us' },
    { pattern: /we will (.+?) by (\d{4}-\d{2}-\d{2})/gi, side: 'us' },
    { pattern: /you will (.+?) by (\d{4}-\d{2}-\d{2})/gi, side: 'customer' },
  ];
  for (const item of patterns) {
    for (const match of body.matchAll(item.pattern)) {
      const text = match[1]?.trim();
      const due = match[2];
      if (text && due) found.push({ text, due, side: item.side });
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
