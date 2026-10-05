export type AIErrorCode =
  | 'configuration'
  | 'invalid_url'
  | 'unsafe_url'
  | 'context_length'
  | 'cancelled'
  | 'timeout'
  | 'upstream_auth'
  | 'upstream_rate_limit'
  | 'upstream_unavailable'
  | 'upstream_error'
  | 'invalid_response'
  | 'content_filtered'
  | 'response_too_large';

/** Only these curated messages may be sent to the browser; never upstream bodies. */
export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: AIErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = options.status ?? 502;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function abortedError(timedOut = false): AIError {
  return timedOut
    ? new AIError('timeout', '模型响应超时，请稍后重试。', { status: 504 })
    : new AIError('cancelled', '已停止本次回复。', { status: 499 });
}

export function isTimeoutSignal(signal?: AbortSignal): boolean {
  const reason: unknown = signal?.reason;
  return (
    !!reason && typeof reason === 'object' && 'name' in reason && reason.name === 'TimeoutError'
  );
}

export function httpError(status: number, retryAfter?: string | null): AIError {
  if (status === 401 || status === 403) {
    return new AIError('upstream_auth', '模型服务鉴权失败，请联系管理员检查 API 密钥与权限。');
  }
  if (status === 429) {
    const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : undefined;
    const dateDelay =
      retryAfter && seconds === undefined ? Date.parse(retryAfter) - Date.now() : undefined;
    const delay = seconds !== undefined ? seconds * 1000 : dateDelay;
    return new AIError('upstream_rate_limit', '模型服务请求过于频繁，请稍后重试。', {
      status: 429,
      retryable: true,
      retryAfterMs:
        delay !== undefined && Number.isFinite(delay)
          ? Math.max(0, Math.min(delay, 30_000))
          : undefined,
    });
  }
  if (status >= 500 && status <= 599) {
    return new AIError('upstream_unavailable', '模型服务暂时不可用，请稍后重试。', {
      retryable: true,
    });
  }
  if (status === 404) {
    return new AIError('configuration', '找不到模型或 API 端点，请联系管理员检查模型服务配置。');
  }
  if (status === 413) {
    return new AIError('context_length', '对话内容超出模型限制，请缩短本次消息或开启新对话。', {
      status: 413,
    });
  }
  return new AIError('upstream_error', '模型服务未能处理本次请求，请重试或联系管理员检查配置。');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function providerEventError(value: unknown): AIError {
  const error = record(value);
  const code = String(error.type ?? error.code ?? error.status ?? '').toLowerCase();
  if (code.includes('rate_limit') || code === 'resource_exhausted' || error.code === 429)
    return httpError(429);
  if (
    code.includes('overloaded') ||
    code === 'server_error' ||
    code === 'internal' ||
    code === 'unavailable' ||
    (typeof error.code === 'number' && error.code >= 500 && error.code <= 599)
  )
    return httpError(503);
  if (code.includes('authentication') || code.includes('permission') || code === 'unauthenticated')
    return httpError(401);
  if (
    code.includes('context_length') ||
    code.includes('token_limit') ||
    code === 'request_too_large'
  )
    return httpError(413);
  if (code.includes('content_filter') || code.includes('safety')) {
    return new AIError('content_filtered', '模型未能回复本次内容，请调整消息后重试。', {
      status: 422,
    });
  }
  return new AIError('upstream_error', '模型服务中断了本次回复，请稍后重试。');
}

export function normalizeAIError(error: unknown, signal?: AbortSignal, timedOut = false): AIError {
  if (signal?.aborted) return abortedError(timedOut || isTimeoutSignal(signal));
  if (error instanceof AIError) return error;
  return new AIError('upstream_unavailable', '无法连接模型服务，请稍后重试或联系管理员。');
}

export function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The caller may already have started fetch/read before the abort was observed.
    // Consume its eventual rejection even though our abort result wins the race.
    void promise.catch(() => undefined);
    return Promise.reject(abortedError(isTimeoutSignal(signal)));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortedError(isTimeoutSignal(signal)));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
