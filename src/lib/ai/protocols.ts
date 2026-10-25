import type { Protocol, ProviderConfig } from '../types';
import { beginAudit, finishAudit, reportedUsage, type AuditContext } from '../audit';

export type ModelProvider = ProviderConfig & { apiKey: string };
export interface ModelImage {
  mime: string;
  /** Base64 without the data: prefix. */
  data: string;
}
export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Only user turns carry images; assistant images are never sent upstream. */
  images?: ModelImage[];
  /** Attachment ids resolved to `images` by the chat engine just before sending. */
  imageRefs?: string[];
}
export interface ModelInput {
  system: string;
  messages: ModelMessage[];
  maxOutput?: number;
}
export interface ModelResult {
  text: string;
  truncated: boolean;
}
export type ModelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Only these sanitized messages may cross the API boundary. Never return an upstream body. */
export class ModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export function assertGenerationConfig(
  provider: Pick<ProviderConfig, 'baseUrl' | 'model' | 'protocol'> & {
    kind?: ProviderConfig['kind'];
  },
): void {
  if (provider.kind === 'embedding')
    throw new ModelError(
      'PROVIDER_EMBEDDING_MODEL',
      '向量模型不能用于角色回复或对话总结，请选择语言模型。',
      422,
    );
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new ModelError('PROVIDER_CONFIG', '模型服务地址无效，请联系管理员。', 503);
  }
  const path = url.pathname.replace(/\/+$/, '');
  const isEmbedding = (model: string) =>
    /^(?:gemini-embedding|text-embedding|embedding|nomic-embed|mxbai-embed)(?:[-_/]|$)/i.test(
      model.replace(/^models\//, ''),
    );
  let endpointModel = '';
  try {
    endpointModel = decodeURIComponent(path.match(/\/models\/([^/]+):[^/]+$/)?.[1] || '');
  } catch {
    throw new ModelError('PROVIDER_CONFIG', '完整模型地址编码无效，请检查供应商地址。', 503);
  }
  if (
    isEmbedding(provider.model) ||
    isEmbedding(endpointModel) ||
    /(?:\/embeddings|:(?:embedContent|batchEmbedContents|asyncBatchEmbedContent))$/i.test(path)
  ) {
    throw new ModelError(
      'PROVIDER_EMBEDDING_MODEL',
      '向量模型或向量接口不能用于角色回复。请在「向量记忆」中配置它，并为角色选择文本生成模型。',
      422,
    );
  }
  const known = path.endsWith('/messages')
    ? 'anthropic'
    : path.endsWith('/completions')
      ? 'openai-completions'
      : path.endsWith('/responses')
        ? 'openai-responses'
        : /:generateContent$/.test(path)
          ? 'gemini'
          : null;
  if (known && known !== provider.protocol)
    throw new ModelError(
      'PROVIDER_PROTOCOL_MISMATCH',
      '完整接口地址与所选生成协议不一致。请使用供应商根地址，或对应协议的完整生成接口。',
      422,
    );
  if (
    endpointModel &&
    /:generateContent$/.test(path) &&
    endpointModel !== provider.model.replace(/^models\//, '')
  )
    throw new ModelError(
      'PROVIDER_CONFIG',
      '完整地址中的模型名称与模型设置不一致，请保持两者一致。',
      422,
    );
}

function reasoningSettings(provider: ModelProvider, maxOutput: number): Record<string, unknown> {
  const effort = provider.reasoningEffort || 'default';
  const budget = provider.thinkingBudget;
  if (effort !== 'default' && budget != null)
    throw new ModelError('REASONING_CONFIG', '思考强度与思考预算不能同时设置。', 422);
  if (
    budget != null &&
    (!Number.isInteger(budget) || budget < 128 || budget > 32768 || budget >= maxOutput)
  )
    throw new ModelError(
      'REASONING_CONFIG',
      '思考预算必须低于最大输出长度，并处于支持的范围内。',
      422,
    );
  if (provider.protocol.startsWith('openai')) {
    if (budget != null)
      throw new ModelError(
        'REASONING_CONFIG',
        'OpenAI 协议不支持独立思考预算，请使用思考强度。',
        422,
      );
    if (effort === 'default') return {};
    return provider.protocol === 'openai-responses'
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };
  }
  if (provider.protocol === 'anthropic') {
    if (effort === 'minimal')
      throw new ModelError('REASONING_CONFIG', 'Anthropic 不支持 minimal 思考强度。', 422);
    if (budget != null) {
      if (budget < 1024)
        throw new ModelError('REASONING_CONFIG', 'Anthropic 思考预算至少为 1024。', 422);
      return { thinking: { type: 'enabled', budget_tokens: budget } };
    }
    if (effort === 'default') return {};
    if (effort === 'none') return { thinking: { type: 'disabled' } };
    return { thinking: { type: 'adaptive' }, output_config: { effort } };
  }
  if (['xhigh', 'max'].includes(effort))
    throw new ModelError(
      'REASONING_CONFIG',
      'Gemini 思考强度仅支持 minimal、low、medium、high。',
      422,
    );
  if (budget != null) return { thinkingConfig: { thinkingBudget: budget } };
  if (effort === 'default') return {};
  if (effort === 'none') {
    if (/^(?:models\/)?gemini-3(?:[.-]|$)/i.test(provider.model))
      throw new ModelError(
        'REASONING_CONFIG',
        'Gemini 3 无法完全关闭思考，请选择受该模型支持的思考强度。',
        422,
      );
    return { thinkingConfig: { thinkingBudget: 0 } };
  }
  if (/^(?:models\/)?gemini-2(?:[.-]|$)/i.test(provider.model))
    throw new ModelError(
      'REASONING_CONFIG',
      'Gemini 2.x 请使用思考预算，不支持 thinkingLevel 强度参数。',
      422,
    );
  return { thinkingConfig: { thinkingLevel: effort.toUpperCase() } };
}

export function maintenanceOutputLimit(provider: ModelProvider, visible = 1024): number {
  return Math.min(provider.maxOutput, Math.max(visible, (provider.thinkingBudget || 0) + 256));
}

function endpoint(provider: ModelProvider, stream = false): URL {
  assertGenerationConfig(provider);
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw new ModelError('PROVIDER_CONFIG', '模型服务地址无效，请联系管理员。', 503);
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ModelError('PROVIDER_CONFIG', '模型服务地址不能包含凭证、查询参数或片段。', 503);
  }
  let path = url.pathname.replace(/\/+$/, '');
  switch (provider.protocol) {
    case 'anthropic':
      if (!path.endsWith('/messages'))
        path += /\/v\d+(?:beta)?$/.test(path) ? '/messages' : '/v1/messages';
      break;
    case 'openai-completions':
      if (!path.endsWith('/completions'))
        path += path ? '/chat/completions' : '/v1/chat/completions';
      break;
    case 'openai-responses':
      if (!path.endsWith('/responses')) path += path ? '/responses' : '/v1/responses';
      break;
    case 'gemini':
      if (!path.endsWith(':generateContent')) {
        if (!path) path = '/v1beta';
        const model = provider.model.replace(/^models\//, '');
        path += `/models/${encodeURIComponent(model)}:generateContent`;
      }
      if (stream) {
        path = path.replace(/:generateContent$/, ':streamGenerateContent');
        url.search = '?alt=sse';
      }
      break;
    default:
      throw new ModelError('PROVIDER_CONFIG', '不支持的模型协议。', 503);
  }
  url.pathname = path;
  return url;
}

function mergeTurns(messages: ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    const last = result.at(-1);
    if (last?.role === message.role) {
      last.content += `\n\n${message.content}`;
      if (message.images?.length) last.images = [...(last.images || []), ...message.images];
    } else result.push({ ...message, images: message.images ? [...message.images] : undefined });
  }
  // Some providers require the first conversational turn to be a user turn.
  if (result[0]?.role === 'assistant')
    result.unshift({ role: 'user', content: '以下是此前的对话记录，请继续当前对话。' });
  if (result.at(-1)?.role === 'assistant')
    result.push({ role: 'user', content: '请结合以上对话，以当前角色继续回应。' });
  return result;
}

function anthropicContent(message: ModelMessage): unknown {
  if (!message.images?.length || message.role !== 'user') return message.content;
  return [
    ...message.images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mime, data: image.data },
    })),
    { type: 'text', text: message.content || '（图片）' },
  ];
}
function openAiChatContent(message: ModelMessage): unknown {
  if (!message.images?.length || message.role !== 'user') return message.content;
  return [
    { type: 'text', text: message.content || '（图片）' },
    ...message.images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,${image.data}` },
    })),
  ];
}
function responsesContent(message: ModelMessage): unknown {
  if (!message.images?.length || message.role !== 'user') return message.content;
  return [
    { type: 'input_text', text: message.content || '（图片）' },
    ...message.images.map((image) => ({
      type: 'input_image',
      image_url: `data:${image.mime};base64,${image.data}`,
    })),
  ];
}
function geminiParts(message: ModelMessage): unknown[] {
  const parts: unknown[] = [];
  if (message.role === 'user')
    for (const image of message.images || [])
      parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  parts.push({ text: message.content || '（图片）' });
  return parts;
}

export function buildModelRequest(
  provider: ModelProvider,
  input: ModelInput,
  options: { stream?: boolean } = {},
) {
  const stream = Boolean(options.stream);
  const url = endpoint(provider, stream);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream, application/json' : 'application/json',
  };
  const messages = mergeTurns(input.messages);
  const maxOutput = Math.max(
    1,
    Math.min(input.maxOutput ?? provider.maxOutput, provider.maxOutput),
  );
  const sampling = provider.temperature === null ? {} : { temperature: provider.temperature };
  const reasoning = reasoningSettings(provider, maxOutput);
  let body: Record<string, unknown>;
  switch (provider.protocol) {
    case 'anthropic':
      if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: provider.model,
        system: input.system,
        messages: messages.map((message) => ({
          role: message.role,
          content: anthropicContent(message),
        })),
        max_tokens: maxOutput,
        stream,
        ...sampling,
        ...reasoning,
      };
      break;
    case 'openai-responses':
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      body = {
        model: provider.model,
        instructions: input.system,
        input: messages.map((message) => ({
          role: message.role,
          content: responsesContent(message),
        })),
        max_output_tokens: maxOutput,
        store: false,
        stream,
        ...sampling,
        ...reasoning,
      };
      break;
    case 'gemini':
      if (provider.apiKey) headers['x-goog-api-key'] = provider.apiKey;
      body = {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: messages.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: geminiParts(message),
        })),
        generationConfig: { maxOutputTokens: maxOutput, ...sampling, ...reasoning },
      };
      break;
    case 'openai-completions': {
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      const legacy = !url.pathname.endsWith('/chat/completions');
      if (legacy && Object.keys(reasoning).length)
        throw new ModelError(
          'REASONING_CONFIG',
          '旧式 Completions 接口不支持思考强度，请使用 Chat Completions 或 Responses。',
          422,
        );
      // Legacy text completions are supported by entering the explicit /completions endpoint.
      const tokens = /^(?:o[1-9]|gpt-[5-9])(?:[-.]|$)/i.test(provider.model)
        ? { max_completion_tokens: maxOutput }
        : { max_tokens: maxOutput };
      body = legacy
        ? {
            model: provider.model,
            prompt: `${input.system}\n\n${messages.map((message) => `${message.role}: ${message.content}`).join('\n\n')}\n\nassistant:`,
            max_tokens: maxOutput,
            ...sampling,
            stream,
          }
        : {
            model: provider.model,
            messages: [
              { role: 'system', content: input.system },
              ...messages.map((message) => ({
                role: message.role,
                content: openAiChatContent(message),
              })),
            ],
            ...tokens,
            ...sampling,
            ...reasoning,
            stream,
            ...(stream ? { stream_options: { include_usage: true } } : {}),
          };
      break;
    }
  }
  return { url: url.toString(), headers, body };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseModelResponse(protocol: Protocol, value: unknown): ModelResult {
  const data = record(value);
  let text = '';
  let truncated = false;
  if (data.error)
    throw new ModelError('PROVIDER_ERROR', '模型服务返回错误，请稍后重试或联系管理员。');
  switch (protocol) {
    case 'anthropic':
      text = array(data.content)
        .map(record)
        .filter((part) => part.type === 'text')
        .map((part) => textValue(part.text))
        .join('');
      truncated = data.stop_reason === 'max_tokens';
      break;
    case 'openai-completions': {
      const choice = record(array(data.choices)[0]);
      const message = record(choice.message);
      text =
        textValue(choice.text) ||
        textValue(message.content) ||
        array(message.content)
          .map(record)
          .filter((part) => part.type === 'text')
          .map((part) => textValue(part.text))
          .join('') ||
        textValue(message.refusal);
      truncated = choice.finish_reason === 'length';
      if (choice.finish_reason === 'content_filter')
        throw new ModelError('PROVIDER_BLOCKED', '模型服务未能生成此内容，请调整消息后重试。', 422);
      break;
    }
    case 'openai-responses':
      if (data.status === 'failed' || data.status === 'cancelled')
        throw new ModelError('PROVIDER_ERROR', '模型服务未完成生成，请稍后重试。');
      text = array(data.output)
        .map(record)
        .filter((item) => item.type === 'message')
        .flatMap((item) => array(item.content))
        .map(record)
        .map((part) =>
          part.type === 'output_text'
            ? textValue(part.text)
            : part.type === 'refusal'
              ? textValue(part.refusal)
              : '',
        )
        .join('');
      truncated =
        data.status === 'incomplete' &&
        record(data.incomplete_details).reason === 'max_output_tokens';
      break;
    case 'gemini': {
      const candidate = record(array(data.candidates)[0]);
      const reason = candidate.finishReason;
      if (
        record(data.promptFeedback).blockReason ||
        ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(
          textValue(reason),
        )
      ) {
        throw new ModelError('PROVIDER_BLOCKED', '模型服务未能生成此内容，请调整消息后重试。', 422);
      }
      text = array(record(candidate.content).parts)
        .map(record)
        .filter((part) => !part.thought)
        .map((part) => textValue(part.text))
        .join('');
      truncated = reason === 'MAX_TOKENS';
      break;
    }
  }
  if (!text.trim())
    throw new ModelError(
      'PROVIDER_EMPTY',
      '模型未返回可显示的内容，请重试或联系管理员调整输出长度。',
    );
  if (text.length > 120_000)
    throw new ModelError('PROVIDER_RESPONSE_SIZE', '模型返回内容过长，请联系管理员调整输出长度。');
  return { text: text.trim(), truncated };
}

function httpError(status: number): ModelError {
  if (status === 401 || status === 403)
    return new ModelError('PROVIDER_AUTH', '模型服务鉴权失败，请联系管理员检查 API 密钥。', 503);
  if (status === 429)
    return new ModelError('PROVIDER_RATE_LIMIT', '模型服务暂时达到请求限额，请稍后重试。', 503);
  if (status === 400 || status === 404 || status === 422)
    return new ModelError(
      'PROVIDER_REQUEST',
      '模型服务不接受当前请求，请联系管理员检查协议、模型、上下文或温度设置。',
      502,
    );
  return new ModelError('PROVIDER_UNAVAILABLE', '模型服务暂时不可用，请稍后重试。', 503);
}

async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelError('PROVIDER_INVALID', '模型服务返回了无效的数据。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 2_000_000) {
        await reader.cancel();
        throw new ModelError('PROVIDER_RESPONSE_SIZE', '模型服务返回的数据过大。');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new ModelError('PROVIDER_INVALID', '模型服务返回了无效的数据，请检查协议配置。');
  }
}

export async function generateText(
  provider: ModelProvider,
  input: ModelInput,
  options: {
    signal?: AbortSignal;
    requestId?: string;
    timeoutMs?: number;
    retries?: number;
    fetcher?: ModelFetch;
    audit?: AuditContext;
  } = {},
): Promise<ModelResult> {
  const request = buildModelRequest(provider, input);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 120_000);
  const signal = options.signal
    ? AbortSignal.any([timeout.signal, options.signal])
    : timeout.signal;
  if (options.requestId && provider.protocol.startsWith('openai'))
    request.headers['Idempotency-Key'] = options.requestId;
  const failureFor = (error: unknown): ModelError => {
    if (options.signal?.aborted)
      return new ModelError('CANCELLED', '生成已停止；已完成的回复仍会保留。', 499);
    if (timeout.signal.aborted)
      return new ModelError('PROVIDER_TIMEOUT', '模型响应超时，本次未完成的调用不计入限额。', 504);
    return error instanceof ModelError
      ? error
      : new ModelError('PROVIDER_NETWORK', '无法连接模型服务，请稍后重试或联系管理员。', 502);
  };
  try {
    const attempts = Math.min(2, Math.max(0, options.retries ?? 1)) + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal.throwIfAborted();
      const audit = options.audit
        ? beginAudit({
            ...options.audit,
            kind: options.audit.kind || 'chat',
            supplierId: provider.supplierId,
            modelId: provider.id,
            requestId: options.audit.requestId || options.requestId,
            protocol: provider.protocol,
            model: provider.model,
            endpoint: request.url,
            attempt: attempt + 1,
            requestBody: request.body,
            secrets: [provider.apiKey],
          })
        : null;
      let httpStatus: number | undefined;
      let usage: ReturnType<typeof reportedUsage> | undefined;
      try {
        const response = await (options.fetcher ?? fetch)(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal,
          redirect: 'error',
          cache: 'no-store',
        });
        httpStatus = response.status;
        if (!response.ok) {
          // Retry only an explicit rejection (rate limit or unavailable), never an ambiguous network failure.
          const retry = [429, 503].includes(response.status) && attempt < attempts - 1;
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          const failure = httpError(response.status);
          finishAudit(audit, {
            status: 'failed',
            httpStatus,
            errorCode: failure.code,
            errorMessage: failure.message,
            responseBody: { error: failure.message },
          });
          if (retry) {
            await delay(
              Math.max(
                100,
                Math.min(
                  3_000,
                  Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1_000
                    : 500 * (attempt + 1),
                ),
              ),
              signal,
            );
            continue;
          }
          throw failure;
        }
        const payload = await boundedJson(response);
        usage = reportedUsage(payload);
        const result = parseModelResponse(provider.protocol, payload);
        finishAudit(audit, {
          status: 'success',
          httpStatus,
          ...usage,
          responseBody: { text: result.text, truncated: result.truncated },
        });
        return result;
      } catch (error) {
        const failure = failureFor(error);
        finishAudit(audit, {
          status: failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
          httpStatus,
          ...usage,
          errorCode: failure.code,
          errorMessage: failure.message,
          responseBody: { error: failure.message },
        });
        throw failure;
      }
    }
    throw new ModelError('PROVIDER_UNAVAILABLE', '模型服务暂时不可用。');
  } catch (error) {
    throw failureFor(error);
  } finally {
    clearTimeout(timer);
  }
}

/** Incremental state for one streamed generation. Exported for protocol tests. */
export class StreamAccumulator {
  text = '';
  truncated = false;
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  constructor(private readonly protocol: Protocol) {}

  /** Returns the newly visible text for one SSE data payload. */
  push(value: unknown): string {
    const data = record(value);
    if (data.error || data.type === 'error' || data.type === 'response.failed')
      throw new ModelError('PROVIDER_ERROR', '模型服务返回错误，请稍后重试或联系管理员。');
    let delta = '';
    switch (this.protocol) {
      case 'anthropic': {
        if (data.type === 'message_start') {
          const usage = record(record(data.message).usage);
          if (typeof usage.input_tokens === 'number') this.inputTokens = usage.input_tokens;
        }
        if (data.type === 'content_block_delta') {
          const part = record(data.delta);
          if (part.type === 'text_delta') delta = textValue(part.text);
        }
        if (data.type === 'message_delta') {
          if (record(data.delta).stop_reason === 'max_tokens') this.truncated = true;
          const usage = record(data.usage);
          if (typeof usage.output_tokens === 'number') this.outputTokens = usage.output_tokens;
        }
        break;
      }
      case 'openai-completions': {
        const usage = record(data.usage);
        if (typeof usage.prompt_tokens === 'number') this.inputTokens = usage.prompt_tokens;
        if (typeof usage.completion_tokens === 'number')
          this.outputTokens = usage.completion_tokens;
        const choice = record(array(data.choices)[0]);
        const message = record(choice.delta);
        delta =
          textValue(choice.text) ||
          textValue(message.content) ||
          array(message.content)
            .map(record)
            .filter((part) => part.type === 'text')
            .map((part) => textValue(part.text))
            .join('') ||
          textValue(message.refusal);
        if (choice.finish_reason === 'length') this.truncated = true;
        if (choice.finish_reason === 'content_filter')
          throw new ModelError(
            'PROVIDER_BLOCKED',
            '模型服务未能生成此内容，请调整消息后重试。',
            422,
          );
        break;
      }
      case 'openai-responses': {
        if (data.type === 'response.output_text.delta' || data.type === 'response.refusal.delta')
          delta = textValue(data.delta);
        if (data.type === 'response.completed' || data.type === 'response.incomplete') {
          const response = record(data.response);
          if (
            response.status === 'incomplete' &&
            record(response.incomplete_details).reason === 'max_output_tokens'
          )
            this.truncated = true;
          const usage = record(response.usage);
          if (typeof usage.input_tokens === 'number') this.inputTokens = usage.input_tokens;
          if (typeof usage.output_tokens === 'number') this.outputTokens = usage.output_tokens;
        }
        if (data.type === 'response.cancelled')
          throw new ModelError('PROVIDER_ERROR', '模型服务未完成生成，请稍后重试。');
        break;
      }
      case 'gemini': {
        const candidate = record(array(data.candidates)[0]);
        const reason = textValue(candidate.finishReason);
        if (
          record(data.promptFeedback).blockReason ||
          ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)
        )
          throw new ModelError(
            'PROVIDER_BLOCKED',
            '模型服务未能生成此内容，请调整消息后重试。',
            422,
          );
        delta = array(record(candidate.content).parts)
          .map(record)
          .filter((part) => !part.thought)
          .map((part) => textValue(part.text))
          .join('');
        if (reason === 'MAX_TOKENS') this.truncated = true;
        const usage = record(data.usageMetadata);
        if (typeof usage.promptTokenCount === 'number') this.inputTokens = usage.promptTokenCount;
        if (typeof usage.candidatesTokenCount === 'number')
          this.outputTokens = usage.candidatesTokenCount;
        break;
      }
    }
    // Leading whitespace is trimmed from the final text; keep the live view consistent with it.
    if (!this.text && delta) delta = delta.replace(/^\s+/, '');
    this.text += delta;
    if (this.text.length > 120_000)
      throw new ModelError(
        'PROVIDER_RESPONSE_SIZE',
        '模型返回内容过长，请联系管理员调整输出长度。',
      );
    return delta;
  }

  result(): ModelResult {
    if (!this.text.trim())
      throw new ModelError(
        'PROVIDER_EMPTY',
        '模型未返回可显示的内容，请重试或联系管理员调整输出长度。',
      );
    return { text: this.text.trim(), truncated: this.truncated };
  }
}

/** Splits a byte stream into SSE `data:` payloads, tolerating CRLF and multi-line data. */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 4_000_000)
        throw new ModelError('PROVIDER_RESPONSE_SIZE', '模型服务返回的数据过大。');
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    const tail = buffer
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Already closed. */
    }
    reader.releaseLock();
  }
}

/**
 * Streams visible text through `onDelta`. Retries happen only before the first
 * byte; a provider that ignores `stream: true` and answers with JSON still works.
 */
export async function streamText(
  provider: ModelProvider,
  input: ModelInput,
  options: {
    onDelta: (text: string) => void;
    signal?: AbortSignal;
    requestId?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    retries?: number;
    fetcher?: ModelFetch;
    audit?: AuditContext;
  },
): Promise<ModelResult> {
  const request = buildModelRequest(provider, input, { stream: true });
  const timeout = new AbortController();
  const idle = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 300_000);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), options.idleTimeoutMs ?? 90_000);
  };
  const signal = AbortSignal.any(
    [timeout.signal, idle.signal, options.signal].filter(Boolean) as AbortSignal[],
  );
  if (options.requestId && provider.protocol.startsWith('openai'))
    request.headers['Idempotency-Key'] = options.requestId;
  const failureFor = (error: unknown): ModelError => {
    if (options.signal?.aborted)
      return new ModelError('CANCELLED', '生成已停止；已完成的回复仍会保留。', 499);
    if (timeout.signal.aborted || idle.signal.aborted)
      return new ModelError('PROVIDER_TIMEOUT', '模型响应超时，本次未完成的调用不计入限额。', 504);
    return error instanceof ModelError
      ? error
      : new ModelError('PROVIDER_NETWORK', '无法连接模型服务，请稍后重试或联系管理员。', 502);
  };
  try {
    const attempts = Math.min(2, Math.max(0, options.retries ?? 1)) + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal.throwIfAborted();
      const audit = options.audit
        ? beginAudit({
            ...options.audit,
            kind: options.audit.kind || 'chat',
            supplierId: provider.supplierId,
            modelId: provider.id,
            requestId: options.audit.requestId || options.requestId,
            protocol: provider.protocol,
            model: provider.model,
            endpoint: request.url,
            attempt: attempt + 1,
            requestBody: request.body,
            secrets: [provider.apiKey],
          })
        : null;
      let httpStatus: number | undefined;
      const accumulator = new StreamAccumulator(provider.protocol);
      try {
        touch();
        const response = await (options.fetcher ?? fetch)(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal,
          redirect: 'error',
          cache: 'no-store',
        });
        httpStatus = response.status;
        if (!response.ok) {
          const retry = [429, 503].includes(response.status) && attempt < attempts - 1;
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          const failure = httpError(response.status);
          finishAudit(audit, {
            status: 'failed',
            httpStatus,
            errorCode: failure.code,
            errorMessage: failure.message,
            responseBody: { error: failure.message },
          });
          if (retry) {
            await delay(
              Math.max(
                100,
                Math.min(
                  3_000,
                  Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1_000
                    : 500 * (attempt + 1),
                ),
              ),
              signal,
            );
            continue;
          }
          throw failure;
        }
        let result: ModelResult;
        let usage: { inputTokens: number | null; outputTokens: number | null };
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          const payload = await boundedJson(response);
          usage = reportedUsage(payload);
          result = parseModelResponse(provider.protocol, payload);
          options.onDelta(result.text);
        } else {
          if (!response.body)
            throw new ModelError('PROVIDER_INVALID', '模型服务返回了无效的数据。');
          for await (const data of sseData(response.body, signal)) {
            touch();
            if (data.trim() === '[DONE]') break;
            let payload: unknown;
            try {
              payload = JSON.parse(data);
            } catch {
              continue; // Comments and keep-alive frames carry no JSON.
            }
            const delta = accumulator.push(payload);
            if (delta) options.onDelta(delta);
          }
          result = accumulator.result();
          usage = { inputTokens: accumulator.inputTokens, outputTokens: accumulator.outputTokens };
        }
        finishAudit(audit, {
          status: 'success',
          httpStatus,
          ...usage,
          responseBody: { text: result.text, truncated: result.truncated, stream: true },
        });
        return result;
      } catch (error) {
        const failure = failureFor(error);
        finishAudit(audit, {
          status: failure.code === 'CANCELLED' ? 'cancelled' : 'failed',
          httpStatus,
          inputTokens: accumulator.inputTokens,
          outputTokens: accumulator.outputTokens,
          errorCode: failure.code,
          errorMessage: failure.message,
          responseBody: { error: failure.message },
        });
        throw failure;
      }
    }
    throw new ModelError('PROVIDER_UNAVAILABLE', '模型服务暂时不可用。');
  } catch (error) {
    throw failureFor(error);
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
  }
}
