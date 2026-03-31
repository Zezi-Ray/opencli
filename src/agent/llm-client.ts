/**
 * LLM Client — multi-provider wrapper supporting Anthropic and OpenAI APIs.
 *
 * Configuration via environment variables:
 *   OPENCLI_PROVIDER=anthropic          (or openai)
 *   OPENCLI_MODEL=sonnet                (alias or full model ID)
 *   OPENCLI_API_KEY=sk-...
 *   OPENCLI_BASE_URL=https://...        (optional, for proxies)
 */

import { AgentResponse } from './types.js';

// ── Types ──────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai';

export interface LLMClientConfig {
  provider?: Provider;
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

// ── Model Aliases ─────────────────────────────────────────────────

const ANTHROPIC_ALIASES: Record<string, string> = {
  'sonnet': 'claude-sonnet-4-20250514',
  'opus': 'claude-opus-4-20250514',
  'haiku': 'claude-haiku-4-20250514',
};

const OPENAI_ALIASES: Record<string, string> = {
  'gpt-5.4': 'gpt-5.4',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4o': 'gpt-4o',
  'o3': 'o3',
  'o4-mini': 'o4-mini',
};

function resolveModelId(alias: string, provider: Provider): string {
  const lower = alias.toLowerCase();
  const table = provider === 'anthropic' ? ANTHROPIC_ALIASES : OPENAI_ALIASES;
  return table[lower] ?? alias;
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
    // Resolve provider (default: anthropic)
    this.provider = config.provider
      ?? (process.env.OPENCLI_PROVIDER as Provider | undefined)
      ?? 'anthropic';
    if (this.provider !== 'anthropic' && this.provider !== 'openai') {
      throw new Error(`Unsupported provider: ${this.provider}. Use 'anthropic' or 'openai'.`);
    }

    // Resolve model (default: sonnet for anthropic, gpt-4o for openai)
    const modelAlias = config.model ?? process.env.OPENCLI_MODEL ?? (this.provider === 'anthropic' ? 'sonnet' : 'gpt-4o');
    this.modelId = resolveModelId(modelAlias, this.provider);

    // Resolve API key
    this.apiKey = config.apiKey ?? process.env.OPENCLI_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error(
        'OPENCLI_API_KEY is not set.\n'
        + 'Configure with:\n'
        + '  export OPENCLI_PROVIDER=anthropic     # or openai\n'
        + '  export OPENCLI_MODEL=sonnet            # alias or full model ID\n'
        + '  export OPENCLI_API_KEY=sk-ant-...      # your API key\n'
        + '  export OPENCLI_BASE_URL=https://...    # optional proxy',
      );
    }

    // Resolve base URL
    this.baseURL = config.baseURL ?? process.env.OPENCLI_BASE_URL ?? undefined;
  }

  getProvider(): Provider { return this.provider; }
  getModelId(): string { return this.modelId; }
  getModelDisplay(): string { return `${this.provider}/${this.modelId}`; }

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
      // Check for HTML response from misconfigured proxy
      const responseStr = JSON.stringify(response);
      if (responseStr.includes('<!doctype') || responseStr.includes('<html')) {
        const base = this.baseURL ?? 'unknown';
        throw new Error(
          `LLM returned HTML instead of JSON — your OPENCLI_BASE_URL may be incorrect.\n`
          + `Current: ${base}\n`
          + `Try: export OPENCLI_BASE_URL='${base.replace(/\/+$/, '')}/v1'`,
        );
      }
      throw new Error('LLM returned empty response');
    }
    return textBlock.text;
  }

  private _trackAnthropicUsage(usage: unknown): void {
    const u = usage as unknown as Record<string, number> | undefined;
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

    // Detect HTML response (proxy returned dashboard page instead of API response)
    const raw = response as unknown;
    if (typeof raw === 'string' && (raw as string).trimStart().startsWith('<!')) {
      const base = this.baseURL ?? 'unknown';
      throw new Error(
        `LLM returned HTML instead of JSON — your OPENCLI_BASE_URL may be incorrect.\n`
        + `Current: ${base}\n`
        + `Try adding /v1: export OPENCLI_BASE_URL='${base.replace(/\/+$/, '')}/v1'`,
      );
    }

    this._trackOpenAIUsage(response.usage);

    const text = response.choices?.[0]?.message?.content;
    if (!text?.trim()) {
      // Check if the response object itself looks like HTML (proxy misconfiguration)
      const responseStr = JSON.stringify(response);
      if (responseStr.includes('<!doctype') || responseStr.includes('<html')) {
        const base = this.baseURL ?? 'unknown';
        throw new Error(
          `LLM returned HTML instead of JSON — your OPENCLI_BASE_URL may be incorrect.\n`
          + `Current: ${base}\n`
          + `Try adding /v1: export OPENCLI_BASE_URL='${base.replace(/\/+$/, '')}/v1'`,
        );
      }
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
