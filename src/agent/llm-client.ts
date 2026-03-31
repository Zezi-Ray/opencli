/**
 * LLM Client — multi-provider wrapper supporting Anthropic and OpenAI APIs.
 *
 * Configuration via environment variables:
 *   OPENCLI_MODEL=anthropic:sonnet     (or openai:gpt-5.4, anthropic:opus, etc.)
 *   OPENCLI_API_KEY=sk-...
 *   OPENCLI_BASE_URL=https://...       (optional, for proxies)
 *
 * Fallback to legacy env vars:
 *   ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL
 *
 * Features:
 * - Anthropic: prompt caching, multimodal (text + image)
 * - OpenAI: multimodal (text + image), structured output
 * - Token tracking with cost estimation
 * - JSON extraction and Zod validation
 */

import { AgentResponse } from './types.js';

// ── Types ──────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai';

export interface LLMClientConfig {
  /** Model string: "anthropic:sonnet", "openai:gpt-5.4", or raw model name */
  model?: string;
  apiKey?: string;
  baseURL?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  screenshot?: string;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  estimatedCost: number;
}

// ── Model Resolution ──────────────────────────────────────────────

interface ResolvedModel {
  provider: Provider;
  modelId: string;
}

const MODEL_ALIASES: Record<string, ResolvedModel> = {
  // Anthropic aliases
  'anthropic:sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
  'anthropic:opus': { provider: 'anthropic', modelId: 'claude-opus-4-20250514' },
  'anthropic:haiku': { provider: 'anthropic', modelId: 'claude-haiku-4-20250514' },
  // OpenAI aliases
  'openai:gpt-5.4': { provider: 'openai', modelId: 'gpt-5.4' },
  'openai:gpt-4.1': { provider: 'openai', modelId: 'gpt-4.1' },
  'openai:gpt-4o': { provider: 'openai', modelId: 'gpt-4o' },
  'openai:o3': { provider: 'openai', modelId: 'o3' },
};

function resolveModel(input: string): ResolvedModel {
  // Check aliases first
  const lower = input.toLowerCase();
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];

  // Check provider:model format
  if (input.includes(':')) {
    const [providerStr, ...modelParts] = input.split(':');
    const modelId = modelParts.join(':');
    const provider = providerStr.toLowerCase() as Provider;
    if (provider === 'anthropic' || provider === 'openai') {
      return { provider, modelId };
    }
  }

  // Guess provider from model name
  if (input.startsWith('claude') || input.startsWith('claude-')) {
    return { provider: 'anthropic', modelId: input };
  }
  if (input.startsWith('gpt') || input.startsWith('o1') || input.startsWith('o3') || input.startsWith('o4')) {
    return { provider: 'openai', modelId: input };
  }

  // Default to anthropic
  return { provider: 'anthropic', modelId: input };
}

// ── Cost Constants ────────────────────────────────────────────────

const COST_TABLES: Record<Provider, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  anthropic: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  openai: { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite: 2.5 },
};

// ── Main Client ───────────────────────────────────────────────────

export class LLMClient {
  private provider: Provider;
  private modelId: string;
  private apiKey: string;
  private baseURL?: string;
  private _totalTokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, estimatedCost: 0 };

  constructor(config: LLMClientConfig = {}) {
    // Resolve model
    const modelStr = config.model
      ?? process.env.OPENCLI_MODEL
      ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic:sonnet' : 'anthropic:sonnet');
    const resolved = resolveModel(modelStr);
    this.provider = resolved.provider;
    this.modelId = resolved.modelId;

    // Resolve API key
    this.apiKey = config.apiKey
      ?? process.env.OPENCLI_API_KEY
      ?? process.env.ANTHROPIC_API_KEY  // legacy fallback
      ?? process.env.OPENAI_API_KEY     // legacy fallback
      ?? '';

    if (!this.apiKey) {
      throw new Error(
        'No API key found. Set OPENCLI_API_KEY or OPENCLI_MODEL + provider-specific key.\n'
        + 'Examples:\n'
        + '  export OPENCLI_API_KEY=sk-ant-...    # Anthropic\n'
        + '  export OPENCLI_API_KEY=sk-...        # OpenAI\n'
        + '  export OPENCLI_MODEL=openai:gpt-5.4  # Specify provider + model',
      );
    }

    // Resolve base URL
    this.baseURL = config.baseURL
      ?? process.env.OPENCLI_BASE_URL
      ?? process.env.ANTHROPIC_BASE_URL  // legacy fallback
      ?? process.env.OPENAI_BASE_URL     // legacy fallback
      ?? undefined;
  }

  /** The resolved provider name */
  getProvider(): Provider { return this.provider; }

  /** The resolved model ID */
  getModelId(): string { return this.modelId; }

  /** Human-readable model display string */
  getModelDisplay(): string { return `${this.provider}:${this.modelId}`; }

  // ── Chat (with AgentResponse validation) ────────────────────────

  async chat(
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    const text = this.provider === 'anthropic'
      ? await this._chatAnthropic(systemPrompt, messages, 4096, signal)
      : await this._chatOpenAI(systemPrompt, messages, 4096, signal);

    const jsonText = extractJson(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`Failed to parse LLM response as JSON: ${(e as Error).message}\nResponse: ${text.slice(0, 500)}`);
    }

    const result = AgentResponse.safeParse(parsed);
    if (!result.success) {
      throw new Error(`LLM response validation failed: ${result.error.message}\nParsed: ${JSON.stringify(parsed).slice(0, 500)}`);
    }
    return result.data;
  }

  // ── Generate Raw (no validation) ────────────────────────────────

  async generateRaw(
    systemPrompt: string,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.provider === 'anthropic'
      ? this._chatAnthropic(systemPrompt, [{ role: 'user', content: userMessage }], 8192, signal)
      : this._chatOpenAI(systemPrompt, [{ role: 'user', content: userMessage }], 8192, signal);
  }

  // ── Token Usage ─────────────────────────────────────────────────

  getTokenUsage(): { input: number; output: number; estimatedCost: number } {
    return { input: this._totalTokens.input, output: this._totalTokens.output, estimatedCost: this._totalTokens.estimatedCost };
  }

  getDetailedTokenUsage(): TokenUsage {
    return { ...this._totalTokens };
  }

  // ── Anthropic Provider ──────────────────────────────────────────

  private async _chatAnthropic(
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL });

    type MessageParam = import('@anthropic-ai/sdk/resources/messages').MessageParam;
    type ContentBlockParam = import('@anthropic-ai/sdk/resources/messages').ContentBlockParam;

    const apiMessages: MessageParam[] = messages.map((m, i) => {
      const isLastUser = m.role === 'user' && i === messages.length - 1;
      if (m.role === 'user' && m.screenshot) {
        const content: ContentBlockParam[] = [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.screenshot } },
          { type: 'text', text: m.content, ...(isLastUser ? { cache_control: { type: 'ephemeral' as const } } : {}) },
        ];
        return { role: m.role, content };
      }
      return {
        role: m.role,
        content: isLastUser
          ? [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }]
          : m.content,
      };
    });

    const requestOptions = signal ? { signal } : undefined;
    const response = await client.messages.create({
      model: this.modelId,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: apiMessages,
    }, requestOptions);

    this._trackAnthropicUsage(response.usage);

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text' || !textBlock.text.trim()) {
      throw new Error('LLM returned empty response');
    }
    return textBlock.text;
  }

  private _trackAnthropicUsage(usage: unknown): void {
    const u = usage as Record<string, number> | undefined;
    const costs = COST_TABLES.anthropic;
    const input = u?.input_tokens ?? 0;
    const output = u?.output_tokens ?? 0;
    const cacheRead = u?.cache_read_input_tokens ?? 0;
    const cacheCreation = u?.cache_creation_input_tokens ?? 0;
    this._totalTokens.input += input;
    this._totalTokens.output += output;
    this._totalTokens.cacheRead += cacheRead;
    this._totalTokens.cacheCreation += cacheCreation;
    this._totalTokens.estimatedCost =
      (this._totalTokens.input / 1e6) * costs.input +
      (this._totalTokens.output / 1e6) * costs.output +
      (this._totalTokens.cacheRead / 1e6) * costs.cacheRead +
      (this._totalTokens.cacheCreation / 1e6) * costs.cacheWrite;
  }

  // ── OpenAI Provider ─────────────────────────────────────────────

  private async _chatOpenAI(
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });

    const apiMessages: Array<{ role: string; content: unknown }> = [
      { role: 'system', content: systemPrompt },
    ];

    for (const m of messages) {
      if (m.role === 'user' && m.screenshot) {
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.screenshot}` } },
            { type: 'text', text: m.content },
          ],
        });
      } else {
        apiMessages.push({ role: m.role, content: m.content });
      }
    }

    const response = await client.chat.completions.create({
      model: this.modelId,
      max_tokens: maxTokens,
      messages: apiMessages as any,
    }, signal ? { signal } : undefined);

    this._trackOpenAIUsage(response.usage);

    const text = response.choices?.[0]?.message?.content;
    if (!text?.trim()) {
      throw new Error('LLM returned empty response');
    }
    return text;
  }

  private _trackOpenAIUsage(usage: unknown): void {
    const u = usage as Record<string, number> | undefined;
    const costs = COST_TABLES.openai;
    const input = u?.prompt_tokens ?? 0;
    const output = u?.completion_tokens ?? 0;
    const details = (u as any)?.prompt_tokens_details;
    const cacheRead = details?.cached_tokens ?? 0;
    this._totalTokens.input += input;
    this._totalTokens.output += output;
    this._totalTokens.cacheRead += cacheRead;
    this._totalTokens.estimatedCost =
      (this._totalTokens.input / 1e6) * costs.input +
      (this._totalTokens.output / 1e6) * costs.output +
      (this._totalTokens.cacheRead / 1e6) * costs.cacheRead;
  }
}

// ── JSON Extraction ────────────────────────────────────────────────

function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  if (start === -1) return trimmed;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return trimmed.slice(start, i + 1); }
  }

  return trimmed.slice(start);
}
