# Scoring

A versioned, explainable health score. Each point up or down traces to a signal and a record.

**Why it exists.** The number has to be the same every time you run it. The model explains the number. It does not invent it.

**One sentence.** "A versioned, explainable health score; each point up or down traces to a signal and a record."

**Public interface.** `scoreSignals(signals, rules) → ScoreResult`. Rules live in `config/scoring-rules.yaml` (`rules_version`). The score starts at 100 and subtracts. Bands: 80 healthy, 60 watch, 40 at risk, below that critical.
