# Evals

Checks the agent gets the known answers right, and measures it. The same harness backtests on history.

**Why it exists.** A playbook change has to pass the known accounts before it is locked.

**One sentence.** "Checks the agent gets the known answers right and measures it. The same harness backtests on real history."

**Public interface.** `runEval({ llm, clock }) → EvalReport`. `pnpm eval` fails when `evals/thresholds.yaml` is missed. Citation validity must be 100%. The same run scores commitment recall, precision, note citations, and overdue flags from `evals/extract-commitments/`.
