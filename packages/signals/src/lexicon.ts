/** Deterministic stand-in for sentiment. The model still writes the prose; the score does not depend on it. */
export const BUDGET_PHRASES = ['procurement review', 'budget cuts', 'budget cut'];

export const NEGATIVE_PHRASES = [
  'unacceptable',
  'frustrated',
  'disappointed',
  'this is ridiculous',
  'angry',
  'cancel the contract',
  'we are not happy',
];

export function containsPhrase(text: string, phrases: string[]): string | null {
  const haystack = text.toLowerCase();
  return phrases.find((phrase) => haystack.includes(phrase)) ?? null;
}
