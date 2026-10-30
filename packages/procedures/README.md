# Procedures

The agent's playbooks: versioned instructions for each job, like an SOP library.

**Why it exists.** Most of the agent's behavior is instructions. Those instructions have to be versioned, testable, and easy to add to.

**One sentence.** "The agent's playbooks: versioned instructions for each job, like an SOP library."

**Public interface.** `loadProcedure(id)`, `renderProcedure({ charter, procedure, houseStyle, inputs }) → { messages, prompt_hash, procedure }`. `procedures.lock.json` pins the body hash. A test fails if the body changes without a version bump.
