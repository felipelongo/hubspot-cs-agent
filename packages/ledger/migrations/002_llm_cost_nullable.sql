-- An unpriced model stores NULL so a missing price is not recorded as $0.
ALTER TABLE llm_calls ALTER COLUMN cost_usd DROP NOT NULL;
ALTER TABLE runs ALTER COLUMN cost_usd DROP NOT NULL;
