# Policy

The rules for what can happen automatically, what needs a human, and what goes to a manager.

**Why it exists.** A CSM can read `config/policy.yaml` and see the safety rules without opening TypeScript.

**One sentence.** "The rules for what can happen automatically, what needs a human, and what goes to a manager."

**Public interface.** `decidePolicy(policy, context) → { effect, policy_version, rule_id, needs_review }`. `accountNeedsLead` is true for a critical account, or an at-risk account at or above the ARR in the file. First matching rule wins.
