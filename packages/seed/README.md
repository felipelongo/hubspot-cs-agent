# Seed data

A realistic fictional customer base with planted problems, so the demo and the tests have known answers.

**Why it exists.** The demo has to show a known at-risk account, a known false alarm, and a prompt-injection note. Those are planted on purpose.

**One sentence.** "A realistic fictional customer base with planted problems, so the demo and tests have known answers."

**Public interface.** `buildSeed(clock) → { database: SeedDatabase, expected: ExpectedFile }` and `writeFixtures(clock, dir?)`. Dates are offsets from the clock, so the bands do not rot. `writeFixtures` writes `fixtures/seed.json` and `fixtures/expected.json`. `fixtures/expected.json` is never uploaded.
