import type { PortalConfig } from '@cs-agent/config';
import type { HubSpotPort, PropertyDefinition } from '@cs-agent/core';

const GROUP = 'cs_agent';

/** Custom company properties from the seat-based seed. Archived only when they are still custom. */
export const DEPRECATED_COMPANY_PROPERTIES = ['seats_purchased', 'seats_active', 'last_login_at'] as const;

export async function setupPortal(
  hubspot: HubSpotPort,
  portal: PortalConfig,
): Promise<{
  created: string[];
  unchanged: string[];
  findings: string[];
  notes: string[];
}> {
  const created: string[] = [];
  const unchanged: string[] = [];
  const findings: string[] = [];
  const notes = await archiveDeprecatedProperties(hubspot);

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

  return { created, unchanged, findings, notes };
}

async function archiveDeprecatedProperties(hubspot: HubSpotPort): Promise<string[]> {
  const listed = await hubspot.listProperties('company');
  const byName = new Map(listed.map((property) => [property.name, property]));
  const notes: string[] = [];
  for (const name of DEPRECATED_COMPANY_PROPERTIES) {
    const property = byName.get(name);
    if (!property) {
      notes.push(`Deprecated company property ${name}: not present.`);
      continue;
    }
    if (property.hubspotDefined) {
      notes.push(`Deprecated company property ${name}: skipped (HubSpot-defined).`);
      continue;
    }
    if (property.readOnly) {
      notes.push(`Deprecated company property ${name}: skipped (read-only).`);
      continue;
    }
    await hubspot.archiveProperty('company', name);
    notes.push(`Deprecated company property ${name}: archived.`);
  }
  return notes;
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
    ...platformProperties(portal),
  ];
}

function platformProperties(portal: PortalConfig): PropertyDefinition[] {
  const platform = portal.platform;
  const number = (name: string, label: string, description: string): PropertyDefinition => ({
    name,
    label,
    type: 'number',
    fieldType: 'number',
    groupName: GROUP,
    description,
  });
  return [
    {
      name: platform.plan,
      label: 'Plan',
      type: 'string',
      fieldType: 'text',
      groupName: GROUP,
      description: 'Donor-engagement plan on the contract.',
    },
    number(platform.arr, 'ARR', 'Annual contract fee.'),
    {
      name: platform.contract_start,
      label: 'Contract start',
      type: 'date',
      fieldType: 'date',
      groupName: GROUP,
      description: 'Date the annual contract started.',
    },
    number(platform.guarantee_multiple, 'Guarantee multiple', 'First-year gift multiple promised against the annual fee.'),
    number(platform.attributed_gifts_ytd, 'Attributed gifts YTD', 'Gifts attributed to the program this year, in dollars.'),
    number(platform.hot_leads_delivered_90d, 'Hot leads delivered 90d', 'Ready-to-give supporters delivered in the last 90 days.'),
    number(platform.hot_leads_followed_up_90d, 'Hot leads followed up 90d', 'Ready-to-give supporters the client followed up in the last 90 days.'),
    number(platform.hot_leads_unworked, 'Hot leads unworked', 'Ready-to-give supporters with no contact logged for more than 14 days.'),
    number(platform.oldest_unworked_lead_days, 'Oldest unworked lead days', 'Days since the oldest unworked ready-to-give supporter was delivered.'),
    {
      name: platform.last_dashboard_login_at,
      label: 'Last dashboard login',
      type: 'datetime',
      fieldType: 'date',
      groupName: GROUP,
      description: 'Latest dashboard login by any client user.',
    },
    number(platform.alert_open_rate_30d, 'Alert open rate 30d', 'Share of fundraiser alerts opened in the last 30 days, from 0 to 1.'),
    number(platform.fiscal_year_start_month, 'Fiscal year start month', 'Month the client fiscal year starts, from 1 to 12.'),
  ];
}
