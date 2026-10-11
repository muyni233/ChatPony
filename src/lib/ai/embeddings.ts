import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb, id, now } from '../db';
import { decrypt } from '../crypto';
import { AppError } from '../errors';
import { beginAudit, finishAudit, reportedUsage, type AuditContext } from '../audit';
import type { Row } from '../mappers';
import type { EmbeddingConfig, Memory } from '../types';

type StoredConfig = {
  enabled: boolean;
  modelId: string;
  topK: number;
  minSimilarity: number;
};
type ResolvedConfig = StoredConfig & {
  supplierId: string;
  model: string;
  modelActive: boolean;
  apiKey: string;
  protocol: 'openai' | 'gemini';
  baseUrl: string;
  supplierName?: string;
  supplierActive: boolean;
  supported: boolean;
};
interface ConfigState {
  value: ResolvedConfig;
  fingerprint: string;
  dimensions: number | null;
}
interface Claim {
  id: string;
  content: string;
  hash: string;
  token: string;
  fingerprint: string;
}
export interface MemoryMatch {
  id: string;
  content: string;
  similarity: number;
}
export interface IndexResult {
  indexed: number;
  failed: number;
  pending: number;
}

const DEFAULTS: StoredConfig = {
  enabled: false,
  modelId: '',
  topK: 6,
  minSimilarity: 0.3,
};
const TIMEOUT_MS = 12_000;
const CLAIM_MS = 30_000;
const BATCH_SIZE = 16;
const textEncoder = new TextEncoder();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fields = z
  .object({
    enabled: z.boolean(),
    modelId: z.string().trim().max(128),
    topK: z.number().int().min(1).max(12),
    minSimilarity: z.number().min(0).max(1),
  })
  .strict();

function storedConfig(): StoredConfig {
  const row = getDb()
    .query("SELECT value FROM settings WHERE key='embeddingConfig'")
    .get() as Row | null;
  if (!row) return { ...DEFAULTS };
  try {
    const parsed = fields.safeParse({ ...DEFAULTS, ...JSON.parse(String(row.value)) });
    if (parsed.success) return parsed.data;
  } catch {
    /* Surface corrupted configuration without printing credentials. */
  }
  throw new AppError(503, 'EMBEDDING_CONFIG', '向量模型配置无法读取，请联系管理员重新设置。');
}

function resolveConfig(config: StoredConfig): ResolvedConfig {
  const model = config.modelId
    ? (getDb().query('SELECT * FROM providers WHERE id=?').get(config.modelId) as Row | null)
    : null;
  const supplier = model?.supplier_id
    ? (getDb()
        .query('SELECT * FROM suppliers WHERE id=?')
        .get(String(model.supplier_id)) as Row | null)
    : null;
  const supported = Boolean(
    supplier &&
      ['openai-completions', 'openai-responses', 'gemini'].includes(String(supplier.protocol)),
  );
  return {
    ...config,
    supplierId: String(model?.supplier_id || ''),
    model: String(model?.model || ''),
    modelActive: Boolean(model?.kind === 'embedding' && model.active && !model.deleted_at),
    protocol: supplier?.protocol === 'gemini' ? 'gemini' : 'openai',
    baseUrl: String(supplier?.base_url || ''),
    apiKey: String(supplier?.api_key || ''),
    supplierName: supplier ? String(supplier.name) : undefined,
    supplierActive: Boolean(
      supplier?.active &&
        !supplier.deleted_at &&
        supported &&
        model?.kind === 'embedding' &&
        model.active &&
        !model.deleted_at,
    ),
    supported,
  };
}

function assertSupplier(config: ResolvedConfig): void {
  if (!config.modelId || !config.model)
    throw new AppError(422, 'EMBEDDING_CONFIG', '请先从模型列表选择向量模型。');
  if (!config.modelActive)
    throw new AppError(
      503,
      'EMBEDDING_MODEL_DISABLED',
      '所选向量模型已停用、删除或类型不正确，请重新选择。',
    );
  if (!config.supplierId || !config.baseUrl)
    throw new AppError(422, 'EMBEDDING_CONFIG', '请先选择向量模型所属的供应商。');
  if (!config.supported)
    throw new AppError(
      422,
      'EMBEDDING_PROTOCOL',
      '所选供应商不支持向量接口，请选择 Gemini 或 OpenAI 兼容协议供应商。',
    );
  if (!config.supplierActive)
    throw new AppError(
      503,
      'EMBEDDING_SUPPLIER_DISABLED',
      '向量模型所属供应商已停用或删除，请联系管理员。',
    );
}

function state(selected = storedConfig()): ConfigState {
  const value = resolveConfig(selected);
  // Credential changes may route a compatible gateway to a different model; invalidate those vectors too.
  const fingerprint = hash(
    JSON.stringify([
      'chatpony-embedding-v1',
      value.modelId,
      value.supplierId,
      value.protocol,
      value.baseUrl.replace(/\/+$/, ''),
      value.model,
      value.apiKey,
    ]),
  );
  const row = getDb()
    .query("SELECT value FROM settings WHERE key='embeddingDimensions'")
    .get() as Row | null;
  let dimensions: number | null = null;
  if (row) {
    try {
      const recorded = JSON.parse(String(row.value));
      if (recorded.fingerprint === fingerprint && Number.isInteger(recorded.dimensions))
        dimensions = recorded.dimensions;
    } catch {
      /* A successful embedding request will replace this cache. */
    }
  }
  return { value, fingerprint, dimensions };
}

export function getEmbeddingSettings(): EmbeddingConfig {
  const {
    apiKey,
    supported: _supported,
    modelActive: _active,
    ...config
  } = resolveConfig(storedConfig());
  return { ...config, hasKey: Boolean(apiKey) };
}

export function updateEmbeddingSettings(input: Record<string, unknown>): EmbeddingConfig {
  const patch = fields.partial().safeParse(input);
  if (!patch.success)
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `向量模型配置无效：${patch.error.issues[0].message}`,
    );
  getDb()
    .transaction(() => {
      const previous = storedConfig();
      const next: StoredConfig = { ...previous, ...patch.data };
      if (
        next.modelId &&
        (next.enabled || patch.data.modelId !== undefined) &&
        !getDb()
          .query("SELECT id FROM providers WHERE id=? AND kind='embedding' AND deleted_at IS NULL")
          .get(next.modelId)
      )
        throw new AppError(
          404,
          'EMBEDDING_MODEL_NOT_FOUND',
          '选择的向量模型不存在或类型不是向量模型。',
        );
      if (next.enabled && !next.modelId)
        throw new AppError(400, 'EMBEDDING_CONFIG', '启用向量记忆前，请选择已配置的向量模型。');
      if (next.enabled) {
        const resolved = resolveConfig(next);
        assertSupplier(resolved);
        endpoint(resolved);
      }
      getDb()
        .query(
          "INSERT INTO settings(key,value) VALUES('embeddingConfig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(next));
    })
    .immediate();
  return getEmbeddingSettings();
}

function vectorStatus(
  memory: { content: string },
  row: Row | null,
  config: ConfigState,
): NonNullable<Memory['vectorStatus']> {
  if (!config.value.enabled || !config.value.supplierActive) return 'disabled';
  if (!row || row.fingerprint !== config.fingerprint || row.content_hash !== hash(memory.content))
    return 'pending';
  if (row.status === 'failed') return 'failed';
  if (
    row.status !== 'ready' ||
    !Number(row.dimensions) ||
    (config.dimensions !== null && Number(row.dimensions) !== config.dimensions)
  )
    return 'pending';
  return 'ready';
}

export function annotateMemoryStatus(memory: Memory): Memory {
  const row = getDb()
    .query(
      'SELECT status,fingerprint,content_hash,dimensions FROM memory_vectors WHERE memory_id=?',
    )
    .get(memory.id) as Row | null;
  return { ...memory, vectorStatus: vectorStatus(memory, row, state()) };
}

/** Normalization preserves the real model's vector; it never synthesizes embeddings. */
function normalizeVector(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16384 ||
    value.some((component) => typeof component !== 'number' || !Number.isFinite(component))
  )
    throw new AppError(502, 'EMBEDDING_INVALID', '向量服务返回了无效的向量数据。');
  const norm = Math.sqrt(value.reduce((sum, component) => sum + component * component, 0));
  if (!Number.isFinite(norm) || norm === 0)
    throw new AppError(502, 'EMBEDDING_INVALID', '向量服务返回了无效的零向量或数值。');
  return value.map((component) => component / norm);
}

export function parseEmbeddings(value: unknown, count: number): number[][] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data))
    throw new AppError(502, 'EMBEDDING_INVALID', '向量服务响应格式不正确，请检查协议配置。');
  const data = (value as { data: unknown[] }).data;
  if (data.length !== count)
    throw new AppError(502, 'EMBEDDING_INVALID', '向量服务返回的数量与请求不一致。');
  const vectors: number[][] = new Array(count);
  for (const item of data) {
    const entry = item as { index?: unknown; embedding?: unknown } | null;
    if (
      !entry ||
      !Number.isInteger(entry.index) ||
      Number(entry.index) < 0 ||
      Number(entry.index) >= count ||
      vectors[Number(entry.index)]
    )
      throw new AppError(502, 'EMBEDDING_INVALID', '向量服务返回了无效的索引。');
    vectors[Number(entry.index)] = normalizeVector(entry.embedding);
  }
  if (vectors.some((vector) => vector.length !== vectors[0].length))
    throw new AppError(502, 'EMBEDDING_INVALID', '向量服务返回了不一致的维度。');
  return vectors;
}

export function cosineSimilarity(left: number[], right: number[]): number | null {
  if (!left.length || left.length !== right.length) return null;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index++) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) return null;
    dot += left[index] * right[index];
    normLeft += left[index] ** 2;
    normRight += right[index] ** 2;
  }
  const denominator = Math.sqrt(normLeft * normRight);
  return denominator > 0 && Number.isFinite(denominator)
    ? Math.max(-1, Math.min(1, dot / denominator))
    : null;
}

function endpoint(config: ResolvedConfig): string {
  const url = new URL(config.baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (
    /(?:\/(?:chat\/completions|completions|responses|messages)|:(?:generateContent|streamGenerateContent))$/i.test(
      path,
    )
  )
    throw new AppError(
      422,
      'EMBEDDING_ENDPOINT',
      '向量服务不能使用聊天生成接口。Gemini 请填写 /v1beta 根地址、:embedContent 或 :batchEmbedContents；OpenAI 兼容服务请使用 /v1 或 /embeddings。',
    );
  if (config.protocol === 'gemini') {
    if (/\/embeddings$/i.test(path))
      throw new AppError(
        422,
        'EMBEDDING_PROTOCOL',
        '当前地址属于 OpenAI 兼容向量协议，请切换协议，或填写 Gemini 原生向量接口。',
      );
    const method = path.match(/:([A-Za-z]+)$/)?.[1];
    if (method && !['embedContent', 'batchEmbedContents'].includes(method))
      throw new AppError(
        422,
        'EMBEDDING_ENDPOINT',
        'Gemini 向量接口仅支持 :embedContent 或 :batchEmbedContents。',
      );
    const match = path.match(/\/models\/([^/]+):(?:embedContent|batchEmbedContents)$/);
    if (match) {
      let model: string;
      try {
        model = decodeURIComponent(match[1]);
      } catch {
        throw new AppError(422, 'EMBEDDING_ENDPOINT', '向量接口模型名称编码无效。');
      }
      if (model !== config.model.replace(/^models\//, ''))
        throw new AppError(
          422,
          'EMBEDDING_MODEL_MISMATCH',
          '完整向量接口中的模型名称与模型设置不一致，请保持两者一致。',
        );
    }
  } else if (/:(?:embedContent|batchEmbedContents|asyncBatchEmbedContent)$/i.test(path))
    throw new AppError(
      422,
      'EMBEDDING_PROTOCOL',
      '当前地址属于 Gemini 原生向量协议，请切换为 Gemini Native，或使用 OpenAI 兼容的 /embeddings 接口。',
    );
  url.pathname =
    config.protocol === 'gemini'
      ? /:(?:embedContent|batchEmbedContents)$/.test(path)
        ? path
        : `${path || '/v1beta'}/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:batchEmbedContents`
      : path.endsWith('/embeddings')
        ? path
        : `${path || '/v1'}/embeddings`;
  return url.toString();
}

export function parseGeminiEmbeddings(value: unknown, count: number, batch: boolean): number[][] {
  const data = value as {
    embedding?: { values?: unknown };
    embeddings?: { values?: unknown }[];
  } | null;
  const entries = batch ? data?.embeddings : data?.embedding ? [data.embedding] : [];
  if (!Array.isArray(entries) || entries.length !== count)
    throw new AppError(502, 'EMBEDDING_INVALID', 'Gemini 返回的向量数量与请求不一致。');
  const vectors = entries.map((entry) => normalizeVector(entry?.values));
  if (vectors.some((vector) => vector.length !== vectors[0].length))
    throw new AppError(502, 'EMBEDDING_INVALID', 'Gemini 返回了不一致的向量维度。');
  return vectors;
}

/** Preserve both the topic and the latest instruction when an unusually long query must be bounded. */
function embeddingInput(text: string): string {
  if (textEncoder.encode(text).length <= 7000) return text;
  const points = [...text];
  const take = (list: string[], budget: number) => {
    const selected: string[] = [];
    let used = 0;
    for (const point of list) {
      const size = textEncoder.encode(point).length;
      if (used + size > budget) break;
      selected.push(point);
      used += size;
    }
    return selected;
  };
  return `${take(points, 3400).join('')}\n…\n${take([...points].reverse(), 3400)
    .reverse()
    .join('')}`;
}

async function requestVectors(
  config: ConfigState,
  inputs: string[],
  signal?: AbortSignal,
  purposes: ('query' | 'document')[] = [],
  auditContext: AuditContext = {},
  connectionTest = false,
): Promise<number[][]> {
  if (!config.value.baseUrl || !config.value.model)
    throw new AppError(422, 'EMBEDDING_CONFIG', '请先填写向量服务地址和模型。');
  assertSupplier(config.value);
  const requestUrl = endpoint(config.value);
  let apiKey: string;
  try {
    apiKey = decrypt(config.value.apiKey);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'EMBEDDING_KEY', '向量模型密钥无法读取，请联系管理员重新设置。');
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    combined.throwIfAborted();
    const post = async (body: Record<string, unknown>): Promise<unknown> => {
      combined.throwIfAborted();
      const url = requestUrl;
      const audit = beginAudit({
        ...auditContext,
        supplierId: config.value.supplierId,
        modelId: config.value.modelId,
        kind: auditContext.kind || 'embedding',
        protocol: config.value.protocol === 'gemini' ? 'gemini-embedding' : 'openai-embeddings',
        model: config.value.model,
        endpoint: url,
        requestBody: body,
        secrets: [apiKey],
      });
      let httpStatus: number | undefined;
      let usage: ReturnType<typeof reportedUsage> | undefined;
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (apiKey)
          headers[config.value.protocol === 'gemini' ? 'x-goog-api-key' : 'Authorization'] =
            config.value.protocol === 'gemini' ? apiKey : `Bearer ${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: combined,
          cache: 'no-store',
        });
        httpStatus = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403)
            throw new AppError(503, 'EMBEDDING_AUTH', '向量服务鉴权失败，请联系管理员检查密钥。');
          if (response.status === 429)
            throw new AppError(
              503,
              'EMBEDDING_RATE_LIMIT',
              '向量服务达到请求限额，请稍后重新索引。',
            );
          throw new AppError(
            502,
            'EMBEDDING_UNAVAILABLE',
            '向量服务暂不可用，请检查地址、模型或稍后重试。',
          );
        }
        if (!response.body) throw new AppError(502, 'EMBEDDING_INVALID', '向量服务没有返回数据。');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > 8_000_000) {
              await reader.cancel();
              throw new AppError(502, 'EMBEDDING_SIZE', '向量服务返回的数据过大。');
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new AppError(502, 'EMBEDDING_INVALID', '向量服务返回了无效的 JSON。');
        }
        usage = reportedUsage(json);
        const validated =
          config.value.protocol === 'gemini'
            ? parseGeminiEmbeddings(
                json,
                Array.isArray(body.requests) ? body.requests.length : 1,
                Array.isArray(body.requests),
              )
            : parseEmbeddings(json, (body.input as string[]).length);
        finishAudit(audit, {
          status: 'success',
          httpStatus,
          ...usage,
          responseBody: {
            vectorCount: validated.length,
            dimensions: validated[0].length,
            ...(body.taskType ? { taskType: body.taskType } : {}),
          },
        });
        return json;
      } catch (error) {
        const failure = signal?.aborted
          ? new AppError(499, 'EMBEDDING_CANCELLED', '向量索引已暂停，可稍后重新索引。')
          : timeout.signal.aborted
            ? new AppError(504, 'EMBEDDING_TIMEOUT', '向量服务响应超时，记忆已保存并等待重新索引。')
            : error instanceof AppError
              ? error
              : new AppError(
                  502,
                  'EMBEDDING_NETWORK',
                  '无法连接向量服务，记忆已保存并等待重新索引。',
                );
        finishAudit(audit, {
          status: failure.code === 'EMBEDDING_CANCELLED' ? 'cancelled' : 'failed',
          httpStatus,
          ...usage,
          errorCode: failure.code,
          errorMessage: failure.message,
          responseBody: { error: failure.message },
        });
        throw failure;
      }
    };
    let vectors: number[][];
    const nativeBody = (input: string, index: number) => ({
      model: `models/${config.value.model.replace(/^models\//, '')}`,
      content: { parts: [{ text: embeddingInput(input) }] },
      taskType: purposes[index] === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
    });
    if (config.value.protocol === 'gemini' && requestUrl.endsWith(':batchEmbedContents')) {
      vectors = parseGeminiEmbeddings(
        await post({ requests: inputs.map(nativeBody) }),
        inputs.length,
        true,
      );
    } else if (config.value.protocol === 'gemini') {
      vectors = [];
      // Native embedContent distinguishes query/document tasks. Bound concurrency and the whole batch deadline.
      for (let offset = 0; offset < inputs.length; offset += 4) {
        const batch = await Promise.allSettled(
          inputs.slice(offset, offset + 4).map(async (input, index) => {
            const result = await post(nativeBody(input, offset + index));
            return parseGeminiEmbeddings(result, 1, false)[0];
          }),
        );
        const failure = batch.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        vectors.push(...batch.map((result) => (result as PromiseFulfilledResult<number[]>).value));
      }
      if (vectors.some((vector) => vector.length !== vectors[0].length))
        throw new AppError(502, 'EMBEDDING_INVALID', '向量服务返回了不一致的维度。');
    } else {
      vectors = parseEmbeddings(
        await post({
          model: config.value.model,
          input: inputs.map(embeddingInput),
          encoding_format: 'float',
        }),
        inputs.length,
      );
    }
    const latest = connectionTest
      ? state({ enabled: false, modelId: config.value.modelId, topK: 1, minSimilarity: 0 })
      : state();
    if (
      latest.fingerprint !== config.fingerprint ||
      (config.value.enabled && !latest.value.enabled) ||
      !latest.value.supplierActive
    )
      throw new AppError(
        409,
        'EMBEDDING_CHANGED',
        '向量配置已更新，记忆将在下次使用新模型重新索引。',
      );
    if (!connectionTest)
      getDb()
        .query(
          "INSERT INTO settings(key,value) VALUES('embeddingDimensions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify({ fingerprint: config.fingerprint, dimensions: vectors[0].length }));
    return vectors;
  } catch (error) {
    if (signal?.aborted)
      throw new AppError(499, 'EMBEDDING_CANCELLED', '向量索引已暂停，可稍后重新索引。');
    if (timeout.signal.aborted)
      throw new AppError(504, 'EMBEDDING_TIMEOUT', '向量服务响应超时，记忆已保存并等待重新索引。');
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'EMBEDDING_NETWORK', '无法连接向量服务，记忆已保存并等待重新索引。');
  } finally {
    clearTimeout(timer);
  }
}

function memoryRows(userId?: string, characterId?: string) {
  const conditions: string[] = [
    'EXISTS(SELECT 1 FROM characters c WHERE c.id=m.character_id AND (c.owner_id IS NULL OR c.owner_id=m.user_id))',
  ];
  const args: string[] = [];
  if (userId) {
    conditions.push('m.user_id=?');
    args.push(userId);
  }
  if (characterId) {
    conditions.push('m.character_id=?');
    args.push(characterId);
  }
  return getDb()
    .query(
      `SELECT m.id,m.content,v.status,v.fingerprint,v.content_hash,v.dimensions,v.updated_at AS vector_updated_at FROM memories m LEFT JOIN memory_vectors v ON v.memory_id=m.id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY CASE m.source WHEN 'manual' THEN 0 ELSE 1 END,m.updated_at ASC,m.rowid ASC`,
    )
    .iterate(...args) as Iterable<Row>;
}

function staleIds(
  config: ConfigState,
  userId?: string,
  characterId?: string,
  limit = BATCH_SIZE,
): string[] {
  const ids: string[] = [];
  for (const row of memoryRows(userId, characterId)) {
    const status = vectorStatus({ content: String(row.content) }, row, config);
    const live =
      row.status === 'pending' &&
      row.fingerprint === config.fingerprint &&
      row.content_hash === hash(String(row.content)) &&
      Date.parse(String(row.vector_updated_at)) > Date.now() - CLAIM_MS;
    if (status !== 'ready' && !live) ids.push(String(row.id));
    if (ids.length >= limit) break;
  }
  return ids;
}

function pendingCount(config: ConfigState, userId?: string, characterId?: string): number {
  let pending = 0;
  for (const row of memoryRows(userId, characterId))
    if (vectorStatus({ content: String(row.content) }, row, config) !== 'ready') pending++;
  return pending;
}

function claimMemories(ids: string[], config: ConfigState): Claim[] {
  const db = getDb();
  return db
    .transaction(() => {
      const claims: Claim[] = [];
      for (const memoryId of [...new Set(ids)].slice(0, BATCH_SIZE)) {
        const memory = db
          .query(
            'SELECT m.content FROM memories m JOIN characters c ON c.id=m.character_id WHERE m.id=? AND (c.owner_id IS NULL OR c.owner_id=m.user_id)',
          )
          .get(memoryId) as Row | null;
        if (!memory) continue;
        const content = String(memory.content);
        const contentHash = hash(content);
        const existing = db
          .query('SELECT * FROM memory_vectors WHERE memory_id=?')
          .get(memoryId) as Row | null;
        if (vectorStatus({ content }, existing, config) === 'ready') continue;
        if (
          existing?.status === 'pending' &&
          existing.fingerprint === config.fingerprint &&
          existing.content_hash === contentHash &&
          Date.parse(String(existing.updated_at)) > Date.now() - CLAIM_MS
        )
          continue;
        const token = now();
        db.query(
          "INSERT INTO memory_vectors(memory_id,vector,dimensions,fingerprint,content_hash,status,error_code,updated_at) VALUES(?,NULL,NULL,?,?,'pending',NULL,?) ON CONFLICT(memory_id) DO UPDATE SET vector=NULL,dimensions=NULL,fingerprint=excluded.fingerprint,content_hash=excluded.content_hash,status='pending',error_code=NULL,updated_at=excluded.updated_at",
        ).run(memoryId, config.fingerprint, contentHash, token);
        claims.push({
          id: memoryId,
          content,
          hash: contentHash,
          token,
          fingerprint: config.fingerprint,
        });
      }
      return claims;
    })
    .immediate();
}

function settleClaims(claims: Claim[], vectors: number[][] | null, code?: string): number {
  const db = getDb();
  return db
    .transaction(() => {
      let indexed = 0;
      for (let index = 0; index < claims.length; index++) {
        const claim = claims[index];
        if (vectors) {
          const current = db
            .query(
              'SELECT m.content FROM memories m JOIN characters c ON c.id=m.character_id WHERE m.id=? AND (c.owner_id IS NULL OR c.owner_id=m.user_id)',
            )
            .get(claim.id) as Row | null;
          // A concurrent edit/deletion must never be overwritten by an obsolete embedding.
          if (!current || hash(String(current.content)) !== claim.hash) continue;
          indexed += db
            .query(
              "UPDATE memory_vectors SET vector=?,dimensions=?,status='ready',error_code=NULL,updated_at=? WHERE memory_id=? AND fingerprint=? AND content_hash=? AND updated_at=? AND status='pending'",
            )
            .run(
              JSON.stringify(vectors[index]),
              vectors[index].length,
              now(),
              claim.id,
              claim.fingerprint,
              claim.hash,
              claim.token,
            ).changes;
        } else {
          db.query(
            "UPDATE memory_vectors SET status='failed',error_code=?,updated_at=? WHERE memory_id=? AND fingerprint=? AND content_hash=? AND updated_at=? AND status='pending'",
          ).run(
            code || 'EMBEDDING_FAILED',
            now(),
            claim.id,
            claim.fingerprint,
            claim.hash,
            claim.token,
          );
        }
      }
      return indexed;
    })
    .immediate();
}

export async function indexMemoryIds(
  ids: string[],
  options: { signal?: AbortSignal; audit?: AuditContext } = {},
): Promise<{ indexed: number; failed: number }> {
  const config = state();
  if (!config.value.enabled || !ids.length) return { indexed: 0, failed: 0 };
  assertSupplier(config.value);
  const claims = claimMemories(ids, config);
  if (!claims.length) return { indexed: 0, failed: 0 };
  const owners = getDb()
    .query(
      `SELECT DISTINCT user_id,character_id FROM memories WHERE id IN (${claims.map(() => '?').join(',')})`,
    )
    .all(...claims.map((claim) => claim.id)) as Row[];
  const users = new Set(owners.map((row) => String(row.user_id)));
  const characters = new Set(owners.map((row) => String(row.character_id)));
  const audit: AuditContext = {
    userId: users.size === 1 ? [...users][0] : null,
    characterId: characters.size === 1 ? [...characters][0] : null,
    requestId: id(),
    ...options.audit,
  };
  try {
    const vectors = await requestVectors(
      config,
      claims.map((claim) => claim.content),
      options.signal,
      [],
      audit,
    );
    return { indexed: settleClaims(claims, vectors), failed: 0 };
  } catch (error) {
    settleClaims(claims, null, error instanceof AppError ? error.code : 'EMBEDDING_FAILED');
    return { indexed: 0, failed: claims.length };
  }
}

export async function reindexMemories(userId?: string, actorId?: string): Promise<IndexResult> {
  const config = state();
  if (!config.value.enabled)
    throw new AppError(409, 'EMBEDDING_DISABLED', '管理员尚未启用向量记忆服务。');
  assertSupplier(config.value);
  const result = await indexMemoryIds(staleIds(config, userId), {
    audit: { userId: actorId || userId || null, requestId: id() },
  });
  return { ...result, pending: pendingCount(state(), userId) };
}

export async function recallMemories(
  userId: string,
  characterId: string,
  query: string,
  options: { signal?: AbortSignal; audit?: AuditContext } = {},
): Promise<{ enabled: boolean; memories: MemoryMatch[] }> {
  const assertAccess = () => {
    if (
      !getDb()
        .query(
          'SELECT id FROM characters WHERE id=? AND (owner_id IS NULL OR owner_id=?) AND deleted_at IS NULL',
        )
        .get(characterId, userId)
    )
      throw new AppError(404, 'NOT_FOUND', '角色不存在。');
  };
  assertAccess();
  const config = state();
  if (!config.value.enabled) return { enabled: false, memories: [] };
  assertSupplier(config.value);
  if (
    !getDb()
      .query('SELECT id FROM memories WHERE user_id=? AND character_id=? LIMIT 1')
      .get(userId, characterId)
  )
    return { enabled: true, memories: [] };
  // Index at most eight pending memories together with the query, so one retrieval takes one outbound call.
  const claims = claimMemories(staleIds(config, userId, characterId, 8), config);
  let vectors: number[][];
  try {
    vectors = await requestVectors(
      config,
      [query, ...claims.map((claim) => claim.content)],
      options.signal,
      ['query', ...claims.map(() => 'document' as const)],
      { userId, characterId, requestId: id(), ...options.audit },
    );
    settleClaims(claims, vectors.slice(1));
  } catch (error) {
    settleClaims(claims, null, error instanceof AppError ? error.code : 'EMBEDDING_FAILED');
    throw error;
  }
  const queryVector = vectors[0];
  assertAccess();
  const matches: MemoryMatch[] = [];
  // Exact cosine search streams rows, avoiding a second full copy of the user's vector corpus.
  const rows = getDb()
    .query(
      "SELECT m.id,m.content,v.vector,v.content_hash FROM memories m JOIN memory_vectors v ON v.memory_id=m.id WHERE m.user_id=? AND m.character_id=? AND v.status='ready' AND v.fingerprint=? AND v.dimensions=? ORDER BY m.updated_at DESC,m.rowid DESC",
    )
    .iterate(userId, characterId, config.fingerprint, queryVector.length) as Iterable<Row>;
  for (const row of rows) {
    if (row.content_hash !== hash(String(row.content))) continue;
    let vector: number[];
    try {
      vector = JSON.parse(String(row.vector));
    } catch {
      continue;
    }
    if (!Array.isArray(vector)) continue;
    const similarity = cosineSimilarity(queryVector, vector);
    if (similarity === null || similarity < config.value.minSimilarity) continue;
    matches.push({ id: String(row.id), content: String(row.content), similarity });
    matches.sort((left, right) => right.similarity - left.similarity);
    if (matches.length > config.value.topK) matches.pop();
  }
  return { enabled: true, memories: matches };
}

export async function testEmbedding(actorId?: string): Promise<{ ok: true; message: string }> {
  const vectors = await requestVectors(state(), ['ChatPony 向量记忆连接测试'], undefined, [], {
    kind: 'connection-test',
    userId: actorId,
    requestId: id(),
  });
  return { ok: true, message: `连接成功，服务返回了 ${vectors[0].length} 维有效向量。` };
}

export async function testEmbeddingModel(
  modelId: string,
  actorId?: string,
): Promise<{ ok: true; message: string }> {
  const selected = state({ enabled: false, modelId, topK: 1, minSimilarity: 0 });
  const vectors = await requestVectors(
    selected,
    ['ChatPony 向量模型连接测试'],
    undefined,
    [],
    { kind: 'connection-test', userId: actorId, requestId: id() },
    true,
  );
  return { ok: true, message: `连接成功，向量模型返回 ${vectors[0].length} 维有效向量。` };
}
