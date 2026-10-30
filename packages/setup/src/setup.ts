import type { PortalConfig } from '@cs-agent/config';
import type { HubSpotPort, PropertyDefinition } from '@cs-agent/core';

const GROUP = 'cs_agent';

export async function setupPortal(
  hubspot: HubSpotPort,
  portal: PortalConfig,
): Promise<{
  created: string[];
  unchanged: string[];
  findings: string[];
}> {
  const created: string[] = [];
  const unchanged: string[] = [];
  const findings: string[] = [];

  const group = await hubspot.createPropertyGroup('company', { name: GROUP, label: 'CS agent' });
  (group.created ? created : unchanged).push(GROUP);

  const existing = new Set((await hubspot.listProperties('company')).map((property) => property.name));
  for (const property of companyProperties(portal)) {
    if (existing.has(property.name)) {
      unchanged.push(property.name);
      continue;
    }
    const result = await hubspot.createProperty('company', property);
    (result.created ? created : unchanged).push(property.name);
  }

  const pipelines = await hubspot.listPipelines('deal');
  const wanted = portal.renewal_pipeline;
  const pipeline = pipelines.find((item) => item.label === wanted.name);
  if (!pipeline) {
    findings.push(`Renewal pipeline "${wanted.name}" is missing.`);
  } else {
    const labels = new Set(pipeline.stages.map((stage) => stage.label));
    for (const stage of wanted.stages) {
      if (!labels.has(stage)) findings.push(`Renewal pipeline "${wanted.name}" is missing stage "${stage}".`);
    }
  }

  return { created, unchanged, findings };
}

function companyName(portal: PortalConfig, key: string): string {
  const name = portal.properties.company[key];
  if (!name) throw new Error(`Portal config is missing company property "${key}".`);
  return name;
}

function companyProperties(portal: PortalConfig): PropertyDefinition[] {
  return [
    {
      name: companyName(portal, 'health_score'),
      label: 'CS health score',
      type: 'number',
      fieldType: 'number',
      groupName: GROUP,
      description: 'Latest health score written by the CS agent.',
    },
    {
      name: companyName(portal, 'health_band'),
      label: 'CS health band',
      type: 'enumeration',
      fieldType: 'select',
      groupName: GROUP,
      description: 'Health band written by the CS agent.',
      options: [
        { label: 'Healthy', value: 'healthy' },
        { label: 'Watch', value: 'watch' },
        { label: 'At risk', value: 'at_risk' },
        { label: 'Critical', value: 'critical' },
      ],
    },
    {
      name: companyName(portal, 'risk_reasons'),
      label: 'CS risk reasons',
      type: 'string',
      fieldType: 'textarea',
      groupName: GROUP,
      description: 'Why the account is in this health band.',
    },
    {
      name: companyName(portal, 'last_assessed_at'),
      label: 'CS last assessed at',
      type: 'datetime',
      fieldType: 'date',
      groupName: GROUP,
      description: 'When the CS agent last scored this company.',
    },
    {
      name: companyName(portal, 'rules_version'),
      label: 'CS rules version',
      type: 'string',
      fieldType: 'text',
      groupName: GROUP,
      description: 'Scoring rules version used for the latest score.',
    },
    {
      name: companyName(portal, 'last_run_id'),
      label: 'CS agent last run id',
      type: 'string',
      fieldType: 'text',
      groupName: GROUP,
      description: 'Ledger run id of the latest assessment.',
    },
    {
      name: companyName(portal, 'open_commitments'),
      label: 'CS open commitments',
      type: 'string',
      fieldType: 'textarea',
      groupName: GROUP,
      description: 'Open commitments the agent is still tracking.',
    },
  ];
}
