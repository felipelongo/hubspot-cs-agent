const BUILTIN: { label: string; pattern: RegExp }[] = [
  { label: 'risk', pattern: /\brisk\b/i },
  { label: 'at_risk', pattern: /at_risk/i },
  { label: 'at risk', pattern: /\bat\s+risk\b/i },
  { label: 'health', pattern: /\bhealth/i },
  { label: 'score', pattern: /\bscore\b/i },
  { label: 'band', pattern: /\bband\b/i },
  { label: 'review places you', pattern: /review\s+places\s+you/i },
  { label: 'guarantee pace', pattern: /guarantee\s+pace/i },
  { label: 'gift pace', pattern: /gift\s+pace/i },
  { label: 'behind the guarantee', pattern: /behind\s+the\s+guarantee/i },
  { label: 'behind the pace', pattern: /behind\s+the\s+pace/i },
  { label: 'attributed gifts', pattern: /attributed\s+gifts/i },
  { label: 'working session', pattern: /working\s+session/i },
];

const MARKER = /\[cs-agent:[^\]]*\]/i;
const ACCOUNT_TEAM = /\bthe account team\b/i;

/** First word of a HubSpot owner name. Blank names do not get an invented signature. */
export function ownerFirstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * Internal phrases a customer draft must not repeat.
 * Rule ids and reason text are included as given. Property names are included only when they start with cs_.
 */
export function customerDraftExtraTerms(input: {
  ruleIds?: string[];
  reasonTexts?: string[];
  propertyNames?: string[];
}): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 4) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(trimmed);
  };
  for (const id of input.ruleIds ?? []) push(id);
  for (const text of input.reasonTexts ?? []) push(text);
  for (const name of input.propertyNames ?? []) {
    if (name.startsWith('cs_')) push(name);
  }
  return terms;
}

/** Why a customer-facing subject or body cannot be sent. Empty means the draft is clean. */
export function customerDraftViolations(
  draft: { subject: string; body: string },
  extraForbidden: string[] = [],
): string[] {
  const text = `${draft.subject}\n${draft.body}`;
  const violations: string[] = [];
  for (const term of BUILTIN) {
    if (term.pattern.test(text)) violations.push(`forbidden term "${term.label}"`);
  }
  if (MARKER.test(text)) violations.push('internal marker [cs-agent:...]');
  if (ACCOUNT_TEAM.test(text)) violations.push('The account team');
  const seen = new Set(violations.map((item) => item.toLowerCase()));
  for (const extra of extraForbidden) {
    const needle = extra.trim();
    if (needle.length < 4) continue;
    if (!text.toLowerCase().includes(needle.toLowerCase())) continue;
    const message = `forbidden text "${needle}"`;
    if (seen.has(message.toLowerCase())) continue;
    seen.add(message.toLowerCase());
    violations.push(message);
  }
  return violations;
}
