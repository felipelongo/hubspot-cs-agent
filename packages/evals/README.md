# Evals

Checks the agent gets the known answers right, and measures it. The same harness backtests on history.

**Why it exists.** A playbook change has to pass the known accounts before it is locked.

**One sentence.** "Checks the agent gets the known answers right and measures it. The same harness backtests on real history."

**Public interface.** `runEval({ llm, clock }) → EvalReport`. `pnpm eval` fails when `evals/thresholds.yaml` is missed. Citation validity must be 100%. The report lists total tokens, estimated USD cost, and a per-model breakdown. A mock run says so and costs 0. A model id with no price is `unknown`, not $0.
