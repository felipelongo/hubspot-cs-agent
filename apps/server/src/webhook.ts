import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 5 * 60 * 1000;

export interface HubSpotSignatureInput {
  method: string;
  url: string;
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string | undefined;
  now: Date;
}

export type SignatureVerdict = { ok: true } | { ok: false; status: 401; reason: string };

/** HubSpot v3: base64 HMAC-SHA256 of method + url + raw body + timestamp. */
export function hubspotV3Signature(input: {
  method: string;
  url: string;
  body: string;
  timestamp: string;
  secret: string;
}): string {
  const source = `${input.method}${input.url}${input.body}${input.timestamp}`;
  return createHmac('sha256', input.secret).update(source).digest('base64');
}

export function verifyHubSpotV3(input: HubSpotSignatureInput): SignatureVerdict {
  if (!input.secret) return { ok: false, status: 401, reason: 'missing secret' };
  if (!input.signature || !input.timestamp) return { ok: false, status: 401, reason: 'missing signature' };
  if (!/^\d+$/.test(input.timestamp)) return { ok: false, status: 401, reason: 'bad timestamp' };
  const sentAt = Number(input.timestamp);
  if (input.now.getTime() - sentAt > MAX_AGE_MS) return { ok: false, status: 401, reason: 'stale timestamp' };
  const expected = hubspotV3Signature({
    method: input.method,
    url: input.url,
    body: input.body,
    timestamp: input.timestamp,
    secret: input.secret,
  });
  if (!signaturesMatch(expected, input.signature)) return { ok: false, status: 401, reason: 'bad signature' };
  return { ok: true };
}

export function webhookResponse(input: HubSpotSignatureInput): Response {
  const verdict = verifyHubSpotV3(input);
  if (!verdict.ok) {
    return Response.json({ ok: false, error: verdict.reason }, { status: verdict.status });
  }
  return Response.json(
    { ok: true, note: 'Signature accepted. A single-account sweep would run for this event.' },
    { status: 202 },
  );
}

function signaturesMatch(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
