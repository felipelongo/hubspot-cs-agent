import { describe, expect, it } from 'vitest';
import { loadModelPrices, loadPolicy, loadPortalConfig, loadScoringRules } from './load.js';

describe('config files', () => {
  it('loads the portal, the score, and the policy', () => {
    const portal = loadPortalConfig();
    expect(portal.properties.company.health_score).toBe('cs_health_score');
    expect(portal.renewal_pipeline.name).toBe('Renewals');
    expect(portal.rate_limits.search_per_second).toBeLessThan(5);
    expect(loadScoringRules().rules.length).toBeGreaterThan(10);
    expect(loadPolicy().default).toBe('approval');
  });

  it('loads placeholder prices for the fast and strong model ids', () => {
    const prices = loadModelPrices();
    expect(prices['claude-haiku-5-5']).toEqual({ input_usd_per_mtok: 1, output_usd_per_mtok: 5 });
    expect(prices['claude-sonnet-5-5']).toEqual({ input_usd_per_mtok: 3, output_usd_per_mtok: 15 });
  });
});
