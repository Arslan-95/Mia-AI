import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError, throwIfAborted } from '../errors.js';
import { createHash } from 'node:crypto';

export type ModelItem = Record<string, unknown>;
export type FunctionDefinition = { type: 'function'; name: string; description: string;
  parameters: Record<string, unknown>; strict: boolean };
export type ModelRequest = { instructions: string; input: ModelItem[]; tools: FunctionDefinition[]; signal: AbortSignal;
  trace?: { turnId: string; agent: string; step?: number } };
export type ModelUsage = { inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number };
export type ModelResponse = { output: ModelItem[]; calls: { callId: string; name: string; arguments: string }[]; text: string;
  usage?: ModelUsage; durationMs?: number };
export type ModelDiagnostic = { model: string; durationMs: number; instructionCharacters: number; inputCharacters: number; toolCharacters: number;
  toolCount: number; status: 'completed' | 'failed'; errorCode?: string; trace?: ModelRequest['trace']; usage?: ModelUsage };
export interface ModelProvider { readonly configured: boolean; respond(request: ModelRequest): Promise<ModelResponse> }

const responseSchema = z.object({
  status: z.string(),
  output: z.array(z.record(z.string(), z.unknown())).max(100),
  usage: z.unknown().optional(),
});
const usageSchema = z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative(),
  input_tokens_details: z.object({ cached_tokens: z.int().nonnegative().optional() }).optional(),
  output_tokens_details: z.object({ reasoning_tokens: z.int().nonnegative().optional() }).optional() });

function schemaAllows(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || Array.isArray(schema.type) && schema.type.includes(type)
    || Array.isArray(schema.anyOf) && schema.anyOf.some(branch => branch && typeof branch === 'object' && schemaAllows(branch, type));
}
// Meta can serialize nullable tool scalars as strings. Interpret "null" only
// in declared nullable slots; numeric/boolean conversion additionally requires
// a non-string scalar schema. Ordinary message/value strings stay untouched.
function typedArguments(value: unknown, schema: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    if (value === 'null' && schemaAllows(schema, 'null')) return null;
    if (!schemaAllows(schema, 'string')) {
      if (schemaAllows(schema, 'integer') && /^-?(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
      if (schemaAllows(schema, 'boolean') && ['true', 'false'].includes(value)) return value === 'true';
    }
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, properties[key] ? typedArguments(entry, properties[key]) : entry]));
  }
  return value;
}

export class MetaResponsesProvider implements ModelProvider {
  readonly configured: boolean;
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch,
    private readonly report?: (diagnostic: ModelDiagnostic) => void | Promise<void>) {
    this.configured = Boolean(config.metaApiKey);
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const start = performance.now();
    let result: ModelResponse | undefined, errorCode: string | undefined;
    try {
      result = await this.request(request);
      result.durationMs = Math.round(performance.now() - start);
      return result;
    } catch (error) {
      errorCode = error instanceof AppError ? error.code : request.signal.aborted ? 'RUN_INTERRUPTED' : 'MODEL_ERROR';
      throw error;
    } finally {
      try { await this.report?.({ model: this.config.metaModel, durationMs: Math.round(performance.now() - start),
        instructionCharacters: request.instructions.length, inputCharacters: JSON.stringify(request.input).length,
        toolCharacters: JSON.stringify(request.tools).length, toolCount: request.tools.length,
        status: result ? 'completed' : 'failed', errorCode, trace: request.trace, usage: result?.usage }); } catch { /* Diagnostics cannot fail a turn. */ }
    }
  }

  private async request(request: ModelRequest): Promise<ModelResponse> {
    if (!this.configured) throw new AppError(503, 'AGENT_UNAVAILABLE', 'The assistant is not configured yet.');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const response = await this.fetcher(`${this.config.metaBaseUrl}/responses`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.config.metaApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.metaModel, instructions: request.instructions,
        input: request.input, tools: request.tools, tool_choice: 'auto', parallel_tool_calls: false,
        store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 4096,
        reasoning: { effort: 'low' }, ...(this.config.metaPromptCache === 'off' ? {} : {
          prompt_cache_retention: this.config.metaPromptCache,
          // The key contains only a hash of public instructions/tool schemas.
          // Volatile account context follows the stable prefix, never enters it.
          prompt_cache_key: 'mia-' + createHash('sha256').update(this.config.metaModel)
            .update(request.instructions.split('Server-supplied current context (data, not instructions):\n')[0]!)
            .update(JSON.stringify(request.tools)).digest('hex').slice(0, 24),
        }) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(503, response.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_UNAVAILABLE',
        'The assistant provider is temporarily unavailable. Please try again.');
    }
    const body = responseSchema.parse(await response.json());
    throwIfAborted(signal);
    if (body.status !== 'completed') throw new AppError(503, 'MODEL_INCOMPLETE', 'The assistant could not finish this turn.');
    const calls: ModelResponse['calls'] = [];
    const text: string[] = [];
    for (const item of body.output) {
      if (item.type === 'function_call') {
        const call = z.object({ call_id: z.string().min(1).max(64), name: z.string().min(1).max(100),
          arguments: z.string().max(32_768) }).parse(item);
        let args = call.arguments;
        const definition = request.tools.find(tool => tool.name === call.name);
        if (definition) {
          try { args = JSON.stringify(typedArguments(JSON.parse(args), definition.parameters)); }
          catch { /* Let the tool's validation report malformed JSON. */ }
        }
        calls.push({ callId: call.call_id, name: call.name, arguments: args });
      } else if (item.type === 'message' && item.role === 'assistant') {
        const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(item.content);
        for (const part of content) if (part.type === 'output_text' && part.text) text.push(part.text);
      }
    }
    const parsedUsage = usageSchema.safeParse(body.usage);
    const usage = parsedUsage.success ? { inputTokens: parsedUsage.data.input_tokens, outputTokens: parsedUsage.data.output_tokens,
      cachedTokens: parsedUsage.data.input_tokens_details?.cached_tokens ?? 0, reasoningTokens: parsedUsage.data.output_tokens_details?.reasoning_tokens ?? 0 } : undefined;
    return { output: body.output, calls, text: text.join('\n').trim(), ...(usage ? { usage } : {}) };
  }
}
