import Anthropic from '@anthropic-ai/sdk';
import { OUTPUT_SCHEMAS, type LlmGenerateInput, type LlmGenerateResult, type LlmPort, type LlmToolCall, type OutputSchemaName } from '@cs-agent/core';
import { createMockLlm } from './mock.js';

/**
 * cost_usd is 0 until a price table is configured.
 * Token counts still come from the SDK usage block when it is present.
 */
const COST_USD = 0;

const SHAPES: Record<OutputSchemaName, string> = {
  RiskAssessment:
    '{"summary":"string","needs_review":false,"reasons":[{"text":"string","citations":["hubspot:object:id"],"signal_keys":["string"]}],"recommended_actions":[{"kind":"set_properties","rationale":"string","citations":["hubspot:object:id"]}]}',
  OutreachDraft:
    '{"subject":"string","body":"string","reasons":[{"text":"string","citations":["hubspot:object:id"]}]}',
  CommitmentExtract:
    '{"commitments":[{"text":"string","owner":"string","due_date":"YYYY-MM-DD or null","overdue":false,"citations":["hubspot:object:id"]}]}',
  QsrPrep:
    '{"experimental":true,"headline":"string","sections":[{"title":"string","bullets":[{"text":"string","citations":["hubspot:object:id"]}]}]}',
  EscalationBrief: '{"lines":["exactly five strings"],"citations":["hubspot:object:id"]}',
};

const READ_TOOLS = [
  {
    name: 'hubspot_read_record',
    description: 'Read one HubSpot record by object and id. This does not change the record.',
    input_schema: {
      type: 'object' as const,
      properties: {
        object: { type: 'string' },
        id: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
      },
      required: ['object', 'id'],
    },
  },
  {
    name: 'hubspot_list_associations',
    description: 'List records associated with one record. This does not change anything.',
    input_schema: {
      type: 'object' as const,
      properties: {
        object: { type: 'string' },
        id: { type: 'string' },
        to: { type: 'string' },
      },
      required: ['object', 'id', 'to'],
    },
  },
  {
    name: 'propose_action',
    description: 'Remember a proposed action. This does not write to HubSpot.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kind: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['kind'],
    },
  },
];

export interface ModelRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string | unknown[] }[];
  tools: typeof READ_TOOLS;
}

export interface ModelBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ModelResponse {
  content: ModelBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export type CreateMessage = (request: ModelRequest) => Promise<ModelResponse>;

export function createLlm(env: NodeJS.ProcessEnv = process.env): LlmPort {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('Anthropic key missing; using MockLLM.');
    return createMockLlm();
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return createAnthropicLlm(async (request) => {
    const message = await client.messages.create({
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages as Anthropic.MessageParam[],
      tools: request.tools,
      stream: false,
    });
    return {
      content: message.content.map((block) => ({
        type: block.type,
        text: block.type === 'text' ? block.text : undefined,
        id: block.type === 'tool_use' ? block.id : undefined,
        name: block.type === 'tool_use' ? block.name : undefined,
        input: block.type === 'tool_use' ? block.input : undefined,
      })),
      stop_reason: message.stop_reason,
      usage: {
        input_tokens: message.usage?.input_tokens,
        output_tokens: message.usage?.output_tokens,
      },
      model: message.model,
    };
  }, env);
}

/** Real client with the HTTP call injected, so tests never reach Anthropic. */
export function createAnthropicLlm(createMessage: CreateMessage, env: NodeJS.ProcessEnv = process.env): LlmPort {
  return {
    async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
      const model = modelForTier(input.tier, env);
      const started = Date.now();
      const schema = OUTPUT_SCHEMAS[input.schema_name];
      const maxSteps = input.max_steps ?? 4;
      const system = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      const seed = input.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      const toolCalls: LlmToolCall[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let modelUsed = model;
      let lastError = '';

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const extra =
          attempt === 0
            ? jsonInstruction(input.schema_name)
            : `${jsonInstruction(input.schema_name)}\n\nThe previous reply failed schema validation:\n${lastError}\nReturn the JSON object again.`;
        const conversation = [...seed, { role: 'user' as const, content: extra }];
        const turn = await runToolLoop({
          createMessage,
          model,
          system,
          messages: conversation,
          maxSteps,
          onTool: input.on_tool,
        });
        inputTokens += turn.inputTokens;
        outputTokens += turn.outputTokens;
        toolCalls.push(...turn.toolCalls);
        if (turn.model) modelUsed = turn.model;
        const parsed = readJson(turn.text);
        if (!parsed.ok) {
          lastError = parsed.error;
          continue;
        }
        const validated = schema.safeParse(parsed.value);
        if (validated.success) {
          return {
            output: validated.data,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            cost_usd: COST_USD,
            model: modelUsed,
            latency_ms: Date.now() - started,
            tool_calls: toolCalls,
          };
        }
        lastError = validated.error.message;
      }

      throw new Error(`The model returned JSON that does not match ${input.schema_name}: ${lastError}`);
    },
  };
}

function modelForTier(tier: 'fast' | 'strong', env: NodeJS.ProcessEnv): string {
  const name = tier === 'fast' ? 'LLM_MODEL_FAST' : 'LLM_MODEL_STRONG';
  const value = env[name]?.trim() ?? '';
  if (!value) {
    throw new Error(`ANTHROPIC_API_KEY is set but ${name} is empty. Set the model id for the ${tier} tier.`);
  }
  return value;
}

function jsonInstruction(schemaName: OutputSchemaName): string {
  return `Return one JSON object for ${schemaName}. No markdown. Shape: ${SHAPES[schemaName]}`;
}

async function runToolLoop(input: {
  createMessage: CreateMessage;
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string | unknown[] }[];
  maxSteps: number;
  onTool?: LlmGenerateInput['on_tool'];
}): Promise<{ text: string; inputTokens: number; outputTokens: number; model?: string; toolCalls: LlmToolCall[] }> {
  const messages = [...input.messages];
  const toolCalls: LlmToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;
  let text = '';
  let steps = 0;

  while (steps < input.maxSteps) {
    steps += 1;
    const response = await input.createMessage({
      model: input.model,
      max_tokens: 4096,
      system: input.system,
      messages,
      tools: READ_TOOLS,
    });
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    if (response.model) model = response.model;
    text = response.content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n');
    const toolUses = response.content.filter((block) => block.type === 'tool_use' && block.name && block.id);
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { text, inputTokens, outputTokens, model, toolCalls };
    }
    const results = [];
    for (const block of toolUses) {
      const call = { name: block.name ?? '', input: block.input };
      toolCalls.push(call);
      const output = input.onTool ? await input.onTool(call) : { error: 'No tool handler was provided.' };
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(output ?? null),
      });
    }
    if (steps >= input.maxSteps) break;
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: results });
  }

  return { text, inputTokens, outputTokens, model, toolCalls };
}

function readJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'The model stopped before it returned JSON.' };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const raw = fenced ? (fenced[1] ?? '').trim() : trimmed;
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(raw.slice(start, end + 1)) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Unreadable JSON.' };
      }
    }
    return { ok: false, error: 'The model did not return JSON.' };
  }
}
