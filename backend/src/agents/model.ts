import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError, throwIfAborted } from '../errors.js';

export type ModelItem = Record<string, unknown>;
export type FunctionDefinition = { type: 'function'; name: string; description: string;
  parameters: Record<string, unknown>; strict: boolean };
export type ModelRequest = { instructions: string; input: ModelItem[]; tools: FunctionDefinition[]; signal: AbortSignal };
export type ModelResponse = { output: ModelItem[]; calls: { callId: string; name: string; arguments: string }[]; text: string };
export interface ModelProvider { readonly configured: boolean; respond(request: ModelRequest): Promise<ModelResponse> }

const responseSchema = z.object({
  status: z.string(),
  output: z.array(z.record(z.string(), z.unknown())).max(100),
});

export class MetaResponsesProvider implements ModelProvider {
  readonly configured: boolean;
  constructor(private readonly config: Config, private readonly fetcher: typeof fetch = fetch) {
    this.configured = Boolean(config.metaApiKey);
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    if (!this.configured) throw new AppError(503, 'AGENT_UNAVAILABLE', 'The assistant is not configured yet.');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const response = await this.fetcher(`${this.config.metaBaseUrl}/responses`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.config.metaApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.metaModel, instructions: request.instructions,
        input: request.input, tools: request.tools, tool_choice: 'auto', parallel_tool_calls: false,
        store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 4096,
        reasoning: { effort: 'low' } }),
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
        calls.push({ callId: call.call_id, name: call.name, arguments: call.arguments });
      } else if (item.type === 'message' && item.role === 'assistant') {
        const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(item.content);
        for (const part of content) if (part.type === 'output_text' && part.text) text.push(part.text);
      }
    }
    return { output: body.output, calls, text: text.join('\n').trim() };
  }
}
