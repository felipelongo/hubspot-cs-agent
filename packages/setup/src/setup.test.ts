import { describe, expect, it } from 'vitest';
import { loadPortalConfig } from '@cs-agent/config';
import type { HubSpotPort, Pipeline, PropertyDefinition, SeedDatabase } from '@cs-agent/core';
import { MockHubSpot } from '@cs-agent/hubspot';
import { setupPortal } from './setup.js';

function emptyDatabase(): SeedDatabase {
  return {
    as_of: '2026-01-01T00:00:00.000Z',
    vendor: { name: 'Harborboard', product: 'Harborboard' },
    owners: [],
    companies: [],
    contacts: [],
    deals: [],
    tickets: [],
    activities: [],
    associations: [],
    history: [],
  };
}

describe('setupPortal', () => {
  it('creates the company fields once and changes nothing the second time', async () => {
    const portal = loadPortalConfig();
    const hubspot = new MockHubSpot(emptyDatabase());
    const first = await setupPortal(hubspot, portal);
    const second = await setupPortal(hubspot, portal);

    expect(first.findings).toEqual([]);
    expect(first.unchanged).toEqual([]);
    expect(first.created).toEqual([
      'cs_agent',
      portal.properties.company.health_score,
      portal.properties.company.health_band,
      portal.properties.company.risk_reasons,
      portal.properties.company.last_assessed_at,
      portal.properties.company.rules_version,
      portal.properties.company.last_run_id,
      portal.properties.company.open_commitments,
    ]);
    expect(second.created).toEqual([]);
    expect(second.unchanged).toEqual(first.created);
    expect(second.findings).toEqual([]);

    const band = await hubspot.getProperty('company', 'cs_health_band');
    expect(band?.type).toBe('enumeration');
    expect(band?.options?.map((option) => option.value)).toEqual(['healthy', 'watch', 'at_risk', 'critical']);
    expect((await hubspot.getProperty('company', 'cs_health_score'))?.fieldType).toBe('number');
    expect((await hubspot.getProperty('company', 'cs_risk_reasons'))?.fieldType).toBe('textarea');
    expect((await hubspot.getProperty('company', 'cs_last_assessed_at'))?.type).toBe('datetime');
    expect((await hubspot.getProperty('company', 'cs_rules_version'))?.fieldType).toBe('text');
  });

  it('reports a missing renewal pipeline or stage and does not throw', async () => {
    const portal = loadPortalConfig();
    const missing = await setupPortal(pipelineStub([]), portal);
    expect(missing.findings).toEqual(['Renewal pipeline "Renewals" is missing.']);

    const partial = await setupPortal(
      pipelineStub([
        {
          id: 'renewals',
          label: 'Renewals',
          stages: [{ id: 'identified', label: 'Renewal identified' }],
        },
      ]),
      portal,
    );
    expect(partial.findings).toEqual(
      portal.renewal_pipeline.stages.slice(1).map((stage) => `Renewal pipeline "Renewals" is missing stage "${stage}".`),
    );
  });
});

function pipelineStub(pipelines: Pipeline[]): HubSpotPort {
  const properties: PropertyDefinition[] = [];
  let groupCreated = false;
  const stub: Pick<HubSpotPort, 'createPropertyGroup' | 'createProperty' | 'listProperties' | 'listPipelines'> = {
    async createPropertyGroup() {
      const created = !groupCreated;
      groupCreated = true;
      return { created };
    },
    async createProperty(_object, property) {
      properties.push(property);
      return { created: true };
    },
    async listProperties() {
      return properties.map((property) => ({ ...property }));
    },
    async listPipelines() {
      return pipelines;
    },
  };
  return stub as unknown as HubSpotPort;
}
