import type { Provider } from '../types';

/** This configuration must stay on the server. Never serialize apiKey to a client. */
export type ProviderConfig = Pick<
  Provider,
  'protocol' | 'baseUrl' | 'model' | 'contextWindow' | 'maxOutputTokens' | 'temperature'
> & { apiKey: string; allowPrivateUrls?: boolean };

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateInput {
  system: string;
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ContextMessage extends AIMessage {
  id: string;
}

export interface ContextInput {
  system: string;
  /** Complete conversation history, including the pending user message. */
  messages: ContextMessage[];
  memory?: string;
  summary?: string;
  /** Last persisted message covered by summary. */
  summaryMessageId?: string | null;
  maxTokens?: number;
  keepRecentMessages?: number;
}

export interface PreparedContext extends GenerateInput {
  summary: string;
  summaryMessageId: string | null;
  compressed: boolean;
  /** Includes output reservation and a token estimation safety margin. */
  estimatedTokens: number;
  maxTokens: number;
}

/** Dependency injection keeps protocol tests offline and free of real credentials. */
export interface AIRuntime {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: (hostname: string) => Promise<readonly { address: string; family: number }[]>;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxEventBytes?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  allowPrivateUrls?: boolean;
}

export interface AIClient {
  generateText(
    config: ProviderConfig,
    input: GenerateInput,
    signal?: AbortSignal,
  ): AsyncGenerator<string>;
  completeText(config: ProviderConfig, input: GenerateInput, signal?: AbortSignal): Promise<string>;
  prepareContext(
    config: ProviderConfig,
    input: ContextInput,
    signal?: AbortSignal,
  ): Promise<PreparedContext>;
}
