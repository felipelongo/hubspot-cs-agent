import { describe, expect, it, vi } from 'vitest';
import { loadPortalConfig } from '@cs-agent/config';
import type { HubSpotOwner, SeedDatabase } from '@cs-agent/core';
import { MockHubSpot } from '@cs-agent/hubspot';
import { seedHubSpot } from './seed.js';

const portal = loadPortalConfig();

/** Portal emails differ only by case. A case-sensitive match would fall back and change ids. */
class CasedOwners extends MockHubSpot {
  override async listOwners(): Promise<HubSpotOwner[]> {
    const owners = await super.listOwners();
    return owners.map((owner) => ({ ...owner, email: owner.email.toUpperCase() }));
  }
}

class SingleOwner extends MockHubSpot {
  override async listOwners(): Promise<HubSpotOwner[]> {
    return [{ id: 'token-user', email: 'token.user@portal.test', firstName: 'Token', lastName: 'User' }];
  }
}

function database(): SeedDatabase {
  return {
    as_of: '2026-01-01T00:00:00.000Z',
    vendor: { name: 'Harborboard', product: 'Harborboard' },
    owners: [
      { id: 'owner-avery', email: 'avery.quinn@example.com', first_name: 'Avery', last_name: 'Quinn', role: 'csm' },
      { id: 'owner-blake', email: 'blake.moreno@example.com', first_name: 'Blake', last_name: 'Moreno', role: 'csm' },
    ],
    companies: [
      {
        id: 'co-avery',
        properties: {
          name: 'Fathom Rye',
          hubspot_owner_id: 'owner-avery',
          seed_csm: 'Avery Quinn',
          seed_external_id: 'co-avery',
        },
      },
      {
        id: 'co-blake',
        properties: {
          name: 'Northwind',
          hubspot_owner_id: 'owner-blake',
          seed_csm: 'Blake Moreno',
          seed_external_id: 'co-blake',
        },
      },
    ],
    contacts: [
      {
        id: 'contact-1',
        properties: {
          email: 'pat@example.com',
          hubspot_owner_id: 'owner-avery',
          seed_csm: 'Avery Quinn',
          seed_external_id: 'contact-1',
        },
      },
    ],
    deals: [
      {
        id: 'deal-1',
        properties: { dealname: 'Renewal', hubspot_owner_id: 'owner-blake', seed_external_id: 'deal-1' },
      },
    ],
    tickets: [
      {
        id: 'ticket-1',
        properties: { subject: 'Outage', hubspot_owner_id: 'owner-avery', seed_external_id: 'ticket-1' },
      },
    ],
    activities: [
      {
        id: 'note-1',
        object: 'note',
        properties: { hs_note_body: 'note', hubspot_owner_id: 'owner-blake', seed_external_id: 'note-1' },
      },
      {
        id: 'email-1',
        object: 'email',
        properties: { hs_email_subject: 'email', hubspot_owner_id: 'owner-avery', seed_external_id: 'email-1' },
      },
      {
        id: 'meeting-1',
        object: 'meeting',
        properties: { hs_meeting_title: 'meeting', hubspot_owner_id: 'owner-blake', seed_external_id: 'meeting-1' },
      },
      {
        id: 'call-1',
        object: 'call',
        properties: { hs_call_title: 'call', hubspot_owner_id: 'owner-avery', seed_external_id: 'call-1' },
      },
    ],
    associations: [],
    history: [],
  };
}

async function ownerId(
  hubspot: MockHubSpot,
  object: 'company' | 'contact' | 'deal' | 'ticket' | 'note' | 'email' | 'meeting' | 'call',
  id: string,
): Promise<string | null> {
  const record = await hubspot.getRecord({ object, id });
  return record?.properties.hubspot_owner_id ?? null;
}

describe('seedHubSpot owner mapping', () => {
  it('keeps fixture hubspot_owner_id when every owner email matches', async () => {
    const hubspot = new CasedOwners(database());
    const summary = await seedHubSpot(hubspot, portal, database());

    expect(await ownerId(hubspot, 'company', 'co-avery')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'company', 'co-blake')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'contact', 'contact-1')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'deal', 'deal-1')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'ticket', 'ticket-1')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'note', 'note-1')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'email', 'email-1')).toBe('owner-avery');
    expect(await ownerId(hubspot, 'meeting', 'meeting-1')).toBe('owner-blake');
    expect(await ownerId(hubspot, 'call', 'call-1')).toBe('owner-avery');
    expect((await hubspot.getRecord({ object: 'company', id: 'co-avery' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect((await hubspot.getRecord({ object: 'contact', id: 'contact-1' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect(summary).toContain('2 matched by email');
    expect(summary).toContain('0 fell back to the token\'s user');
  });

  it('maps every hubspot_owner_id to the token user when no email matches', async () => {
    const source = database();
    const hubspot = new SingleOwner(source);
    const summary = await seedHubSpot(hubspot, portal, source);

    for (const [object, id] of [
      ['company', 'co-avery'],
      ['company', 'co-blake'],
      ['contact', 'contact-1'],
      ['deal', 'deal-1'],
      ['ticket', 'ticket-1'],
      ['note', 'note-1'],
      ['email', 'email-1'],
      ['meeting', 'meeting-1'],
      ['call', 'call-1'],
    ] as const) {
      expect(await ownerId(hubspot, object, id)).toBe('token-user');
    }
    expect((await hubspot.getRecord({ object: 'company', id: 'co-avery' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect((await hubspot.getRecord({ object: 'company', id: 'co-blake' }))?.properties.seed_csm).toBe('Blake Moreno');
    expect((await hubspot.getRecord({ object: 'contact', id: 'contact-1' }))?.properties.seed_csm).toBe('Avery Quinn');
    expect(summary).toContain('0 matched by email');
    expect(summary).toContain('2 fell back to the token\'s user');
  });

  it('fails with the owners scope when the portal has no owners', async () => {
    const source = database();
    source.owners = [];
    const hubspot = new MockHubSpot(source);
    const upsert = vi.spyOn(hubspot, 'batchUpsert');

    await expect(seedHubSpot(hubspot, portal, source)).rejects.toThrow(/crm\.objects\.owners\.read/);
    await expect(seedHubSpot(hubspot, portal, source)).rejects.toThrow(/docs\/hubspot\/scopes\.md/);
    expect(upsert).not.toHaveBeenCalled();
  });
});
