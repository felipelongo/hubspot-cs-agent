import { describe, expect, it } from 'vitest';
import { loadPolicy, loadPortalConfig, loadScoringRules } from './load.js';

describe('config files', () => {
  it('loads the portal, the score, and the policy', () => {
    const portal = loadPortalConfig();
    expect(portal.properties.company.health_score).toBe('cs_health_score');
    expect(portal.renewal_pipeline.name).toBe('Renewals');
    expect(portal.rate_limits.search_per_second).toBeLessThan(5);
    expect(loadScoringRules().rules.length).toBeGreaterThan(10);
    expect(loadPolicy().default).toBe('approval');
  });
});
