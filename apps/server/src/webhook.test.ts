import { describe, expect, it } from 'vitest';
import { sweepMode, verifyHubSpotV3, webhookResponse } from './webhook.js';

const secret = 'top-secret';
const method = 'POST';
const url = 'https://console.example.com/webhooks/hubspot';
const body = '{"subscriptionType":"company.propertyChange","objectId":42}';
const timestamp = '1761800000000';
const signature = 'rH9UjqMLHyTQrUtmys6Au0nPfvOgjEL3Yq+r8sXfIpM=';
const now = new Date(Number(timestamp));

describe('HubSpot v3 signatures', () => {
  it('defaults the sweep to shadow and never treats an unknown mode as live', () => {
    expect(sweepMode({})).toBe('shadow');
    expect(sweepMode({ MODE: 'live' })).toBe('live');
    expect(sweepMode({ MODE: 'dry_run' })).toBe('dry_run');
    expect(sweepMode({ MODE: 'production' })).toBe('shadow');
  });

  it('accepts a known secret and body', () => {
    expect(verifyHubSpotV3({ method, url, body, timestamp, signature, secret, now })).toEqual({ ok: true });
  });

  it('rejects a stale timestamp even when the signature matches that timestamp', () => {
    const later = new Date(Number(timestamp) + 6 * 60 * 1000);
    expect(verifyHubSpotV3({ method, url, body, timestamp, signature, secret, now: later })).toEqual({
      ok: false,
      status: 401,
      reason: 'stale timestamp',
    });
  });

  it('rejects a bad signature and a missing secret', async () => {
    expect(verifyHubSpotV3({ method, url, body, timestamp, signature: 'nope', secret, now }).ok).toBe(false);
    expect(verifyHubSpotV3({ method, url, body, timestamp, signature, secret: undefined, now }).ok).toBe(false);
    const response = webhookResponse({ method, url, body, timestamp, signature, secret: undefined, now });
    expect(response.status).toBe(401);
    const accepted = webhookResponse({ method, url, body, timestamp, signature, secret, now });
    expect(accepted.status).toBe(202);
    const payload = (await accepted.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});
