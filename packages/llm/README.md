# LLM port

One interface to the model, with structured outputs, retries, and cost logging. The provider can be swapped.

**Why it exists.** The rest of the system should not know whether the text came from Anthropic or from the fixture model.

**One sentence.** "One interface to the model, with structured outputs, retries and cost logging; the provider can be swapped."

**Public interface.** `createLlm(env) → LlmPort`. `generate({ messages, schema_name, tier, on_tool }) → { output, usage, cost_usd, model, latency_ms }`. No API key means `MockLLM`, and the process prints one line saying so.
