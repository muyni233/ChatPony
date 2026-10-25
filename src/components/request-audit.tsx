'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileSearch,
  Filter,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Button, EmptyState, Field, Modal, Select } from '@/components/ui';
import { api } from '@/lib/client';
import type {
  ProviderConfig,
  RequestAudit,
  RequestAuditDetail,
  RequestAuditList,
  RequestAuditStats,
  SupplierConfig,
  User,
} from '@/lib/types';
import './request-audit.css';

type Filters = {
  search: string;
  userId: string;
  supplierId: string;
  modelId: string;
  status: string;
  kind: string;
  from: string;
  to: string;
};
const emptyFilters: Filters = {
  search: '',
  userId: '',
  supplierId: '',
  modelId: '',
  status: '',
  kind: '',
  from: '',
  to: '',
};
const kinds: Record<RequestAudit['kind'], string> = {
  chat: '角色对话',
  embedding: '向量请求',
  'connection-test': '连接测试',
  compression: '上下文压缩',
  'memory-summary': '记忆汇总',
};
const statuses: Record<RequestAudit['status'], string> = {
  pending: '处理中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};
const periods = { '24h': '近 24 小时', '7d': '近 7 天', '30d': '近 30 天', all: '全部保留记录' };

function message(error: unknown) {
  return error instanceof Error ? error.message : '读取请求记录失败，请稍后重试。';
}
function count(value: number | null) {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN').format(value);
}
function duration(value: number | null) {
  if (value === null) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
function timestamp(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
function shortTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
function prettyBody(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value || '（空内容）';
  }
}
function StatusBadge({ status }: { status: RequestAudit['status'] }) {
  return (
    <Badge
      tone={
        status === 'success'
          ? 'green'
          : status === 'failed'
            ? 'pink'
            : status === 'pending'
              ? 'amber'
              : 'neutral'
      }
    >
      {statuses[status]}
    </Badge>
  );
}
function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="audit-error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
function DetailValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
function BodyPanel({
  title,
  body,
  truncated,
  enabled,
}: {
  title: string;
  body: string | null;
  truncated: boolean;
  enabled: boolean;
}) {
  return (
    <section className="audit-body-panel">
      <div className="audit-body-heading">
        <h4>{title}</h4>
        {enabled && truncated && <Badge tone="amber">内容已截断</Badge>}
      </div>
      {!enabled ? (
        <div className="audit-body-empty">
          <LockKeyhole size={17} />
          <p>当前已关闭内容捕获，此处仅展示请求元数据。</p>
        </div>
      ) : body === null ? (
        <div className="audit-body-empty">
          <FileSearch size={17} />
          <p>此请求未保存该内容。开启捕获前的历史请求不会补录。</p>
        </div>
      ) : (
        <pre tabIndex={0} aria-label={title}>
          {prettyBody(body)}
        </pre>
      )}
    </section>
  );
}

export function RequestAuditPanel({
  users,
  suppliers,
  models,
  captureEnabled,
  retentionDays,
  onOpenSettings,
}: {
  users: User[];
  suppliers: SupplierConfig[];
  models: ProviderConfig[];
  captureEnabled: boolean;
  retentionDays: number;
  onOpenSettings: () => void;
}) {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [filterError, setFilterError] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [period, setPeriod] = useState<keyof typeof periods>('7d');
  const [refreshKey, setRefreshKey] = useState(0);
  const [result, setResult] = useState<RequestAuditList | null>(null);
  const [stats, setStats] = useState<RequestAuditStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [error, setError] = useState('');
  const [statsError, setStatsError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequestAuditDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRefresh, setDetailRefresh] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    for (const [key, value] of Object.entries(filters)) {
      if (!value) continue;
      if (key === 'from') params.set(key, new Date(`${value}T00:00:00`).toISOString());
      else if (key === 'to') params.set(key, new Date(`${value}T23:59:59.999`).toISOString());
      else params.set(key, value);
    }
    return params.toString();
  }, [filters, page, pageSize]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<RequestAuditList>(`/api/admin/requests?${query}`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setResult(value);
        const last = Math.max(1, Math.ceil(value.total / value.pageSize));
        if (value.page > last) setPage(last);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    setStatsLoading(true);
    setStatsError('');
    setStats(null);
    api<RequestAuditStats>(`/api/admin/requests/stats?period=${period}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setStats(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setStatsError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatsLoading(false);
      });
    return () => controller.abort();
  }, [period, refreshKey]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError('');
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError('');
    setDetail(null);
    api<RequestAuditDetail>(`/api/admin/requests/${encodeURIComponent(selectedId)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDetail(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setDetailError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, detailRefresh]);

  const supplierOptions = useMemo(() => {
    const entries = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
    for (const row of result?.items ?? [])
      if (row.supplierId && !entries.has(row.supplierId))
        entries.set(row.supplierId, row.supplierName || row.supplierId);
    if (draft.supplierId && !entries.has(draft.supplierId))
      entries.set(draft.supplierId, draft.supplierId);
    return [...entries];
  }, [suppliers, result?.items, draft.supplierId]);
  const modelOptions = useMemo(() => {
    const entries = new Map(
      models
        .filter((model) => !draft.supplierId || model.supplierId === draft.supplierId)
        .map((model) => [model.id, `${model.name} · ${model.model}`]),
    );
    for (const row of result?.items ?? [])
      if (
        row.modelId &&
        (!draft.supplierId || row.supplierId === draft.supplierId) &&
        !entries.has(row.modelId)
      )
        entries.set(row.modelId, row.model || row.modelId);
    if (draft.modelId && !entries.has(draft.modelId)) entries.set(draft.modelId, draft.modelId);
    return [...entries];
  }, [models, result?.items, draft.supplierId, draft.modelId]);
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / pageSize));
  const activeFilters = Object.values(filters).filter(Boolean).length;

  function apply(event: FormEvent) {
    event.preventDefault();
    setFilterError('');
    if (draft.from && draft.to && draft.from > draft.to) {
      setFilterError('开始日期不能晚于结束日期。');
      return;
    }
    setFilters({ ...draft, search: draft.search.trim() });
    setPage(1);
  }
  function resetFilters() {
    setDraft(emptyFilters);
    setFilters(emptyFilters);
    setFilterError('');
    setPage(1);
  }
  function change(key: keyof Filters, value: string) {
    setFilterError('');
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      ...(key === 'supplierId' ? { modelId: '' } : {}),
    }));
  }

  return (
    <div className="audit-page">
      <div className="admin-section-title">
        <div>
          <h2>请求审查</h2>
          <p>查看模型与向量请求的执行结果、耗时、用量和错误信息。</p>
        </div>
        <Button
          variant="secondary"
          loading={loading || statsLoading}
          onClick={() => setRefreshKey((value) => value + 1)}
        >
          <RefreshCw size={16} />
          刷新记录
        </Button>
      </div>
      <div className="audit-stats-heading">
        <span>平台请求统计</span>
        <Select
          aria-label="统计周期"
          value={period}
          onValueChange={(value) => setPeriod(value as keyof typeof periods)}
        >
          {Object.entries(periods).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <ErrorBox error={statsError} />
      <div className="audit-stats" aria-busy={statsLoading}>
        {[
          {
            label: '请求总数',
            value: stats ? count(stats.total) : '—',
            note: `${periods[period]} · HTTP 请求尝试`,
            icon: <Activity size={19} />,
            tone: 'green',
          },
          {
            label: '成功请求',
            value: stats ? count(stats.success) : '—',
            note: stats ? `${count(stats.pending)} 个请求处理中` : '等待统计结果',
            icon: <CheckCircle2 size={19} />,
            tone: 'blue',
          },
          {
            label: '失败与取消',
            value: stats ? count(stats.failed) : '—',
            note: '可按状态分别筛选并查看错误',
            icon: <AlertCircle size={19} />,
            tone: 'pink',
          },
          {
            label: '平均耗时',
            value: stats ? duration(stats.avgDurationMs) : '—',
            note: stats
              ? `输入 ${count(stats.inputTokens)} / 输出 ${count(stats.outputTokens)} Token`
              : '服务商上报的 Token 用量',
            icon: <Clock3 size={19} />,
            tone: 'yellow',
          },
        ].map((item) => (
          <article className={`audit-stat audit-stat-${item.tone}`} key={item.label}>
            <div>
              <span>{item.label}</span>
              {item.icon}
            </div>
            <strong>{item.value}</strong>
            <small>{item.note}</small>
          </article>
        ))}
      </div>
      <div className={`audit-policy ${captureEnabled ? 'audit-policy-capture' : ''}`}>
        <ShieldCheck size={18} />
        <p>
          {captureEnabled
            ? '已开启请求内容捕获，记录可能包含用户对话与角色人设。'
            : '请求内容捕获已关闭，仅记录状态、耗时等元数据。'}
          <span>记录保留 {retentionDays} 天，认证凭据不会记录。</span>
        </p>
        <button className="admin-text-link" type="button" onClick={onOpenSettings}>
          记录设置 <ArrowUpRight size={14} />
        </button>
      </div>
      <form className="audit-filters" onSubmit={apply}>
        <div className="audit-filter-heading">
          <h3>
            <Filter size={15} />
            筛选请求
          </h3>
          {activeFilters > 0 && <span>已应用 {activeFilters} 项条件</span>}
        </div>
        <ErrorBox error={filterError} />
        <div className="audit-filter-grid">
          <Field label="搜索">
            <div className="audit-search-input">
              <Search size={16} />
              <input
                maxLength={200}
                placeholder="搜索请求记录"
                value={draft.search}
                onChange={(event) => change('search', event.target.value)}
              />
            </div>
          </Field>
          <Field label="用户">
            <Select value={draft.userId} onValueChange={(value) => change('userId', value)}>
              <option value="">全部用户</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} · {user.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="供应商">
            <Select value={draft.supplierId} onValueChange={(value) => change('supplierId', value)}>
              <option value="">全部供应商</option>
              {supplierOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="模型">
            <Select value={draft.modelId} onValueChange={(value) => change('modelId', value)}>
              <option value="">全部模型</option>
              {modelOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="请求类型">
            <Select value={draft.kind} onValueChange={(value) => change('kind', value)}>
              <option value="">全部类型</option>
              {Object.entries(kinds).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="请求状态">
            <Select value={draft.status} onValueChange={(value) => change('status', value)}>
              <option value="">全部状态</option>
              {Object.entries(statuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="开始日期">
            <input
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(event) => change('from', event.target.value)}
            />
          </Field>
          <Field label="结束日期">
            <input
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) => change('to', event.target.value)}
            />
          </Field>
        </div>
        <div className="audit-filter-actions">
          <span>日期按当前浏览器时区筛选。</span>
          <Button type="button" variant="ghost" onClick={resetFilters}>
            清除筛选
          </Button>
          <Button type="submit" loading={loading}>
            <Search size={15} />
            应用筛选
          </Button>
        </div>
      </form>
      <ErrorBox error={error} />
      <section className="audit-results" aria-busy={loading}>
        <div className="audit-results-heading">
          <h3>
            请求记录 <span>{result ? count(result.total) : '—'}</span>
          </h3>
          {loading && (
            <span className="audit-loading-inline" role="status">
              <RefreshCw size={13} className="spin" />
              正在加载
            </span>
          )}
          <label>
            每页
            <Select
              aria-label="每页记录数"
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value));
                setPage(1);
              }}
            >
              <option value={10}>10 条</option>
              <option value={20}>20 条</option>
              <option value={50}>50 条</option>
            </Select>
          </label>
        </div>
        {result?.items.length ? (
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>时间 / 请求</th>
                  <th>用户 / 角色</th>
                  <th>供应商 / 模型</th>
                  <th>状态</th>
                  <th>耗时 / Token</th>
                  <th>
                    <span className="admin-sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <time dateTime={row.createdAt} title={timestamp(row.createdAt)}>
                        {shortTime(row.createdAt)}
                      </time>
                      <small>
                        {kinds[row.kind]}
                        {row.attempt > 1 && ` · 第 ${row.attempt} 次尝试`}
                      </small>
                    </td>
                    <td>
                      <strong>{row.userName || (row.userId ? row.userId.slice(0, 8) : '—')}</strong>
                      <small>{row.characterName || '—'}</small>
                    </td>
                    <td>
                      <strong>{row.model || '—'}</strong>
                      <small>{row.supplierName || '—'}</small>
                    </td>
                    <td>
                      <StatusBadge status={row.status} />
                      <small>
                        {row.httpStatus === null ? row.errorCode || '—' : `HTTP ${row.httpStatus}`}
                      </small>
                    </td>
                    <td>
                      <strong className="audit-numeric">{duration(row.durationMs)}</strong>
                      <small title="输入 / 输出 Token">
                        {count(row.inputTokens)} / {count(row.outputTokens)}
                      </small>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="audit-detail-button"
                        aria-label={`查看请求 ${row.id}`}
                        onClick={() => setSelectedId(row.id)}
                      >
                        详情
                        <ChevronRight size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : loading ? (
          <div className="audit-table-loading" role="status">
            <RefreshCw className="spin" size={23} />
            <p>正在读取请求记录…</p>
          </div>
        ) : (
          <EmptyState
            icon={<FileSearch size={28} />}
            title={
              error ? '暂时无法读取请求' : activeFilters ? '没有符合条件的请求' : '暂无请求记录'
            }
            description={
              error
                ? '请检查错误信息，稍后刷新重试。'
                : activeFilters
                  ? '调整用户、模型、状态或日期条件后重试。'
                  : '模型或向量请求产生后，执行记录会显示在这里。'
            }
            action={
              activeFilters ? (
                <Button variant="secondary" onClick={resetFilters}>
                  清除筛选
                </Button>
              ) : undefined
            }
          />
        )}
        <div className="audit-pagination">
          <span>
            第 {Math.min(page, pageCount)} / {pageCount} 页
          </span>
          <div>
            <Button
              variant="ghost"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft size={15} />
              上一页
            </Button>
            <Button
              variant="ghost"
              disabled={page >= pageCount || loading}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
              <ChevronRight size={15} />
            </Button>
          </div>
        </div>
      </section>
      <p className="audit-footnote">
        每次实际 HTTP
        尝试单独记录，重试、向量请求和连接测试也会计入；这里的请求数与用户的调用额度统计不同。Token
        仅采用服务商上报的用量，未上报时显示「—」。
      </p>
      <Modal
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        title="请求详情"
        description={selectedId || undefined}
        wide
      >
        {detailLoading && (
          <div className="audit-table-loading" role="status">
            <RefreshCw size={22} className="spin" />
            <p>正在读取请求详情…</p>
          </div>
        )}
        <ErrorBox error={detailError} />
        {detailError && (
          <Button variant="secondary" onClick={() => setDetailRefresh((value) => value + 1)}>
            重新加载详情
          </Button>
        )}
        {detail && (
          <div className="audit-detail">
            <div className="audit-detail-status">
              <StatusBadge status={detail.status} />
              <span>
                {kinds[detail.kind]} · 第 {detail.attempt} 次尝试
              </span>
              <strong>{duration(detail.durationMs)}</strong>
            </div>
            {(detail.errorCode || detail.errorMessage) && (
              <div className="audit-error" role="status">
                <AlertCircle size={17} />
                <span>
                  <strong>{detail.errorCode || '请求失败'}</strong>
                  {detail.errorMessage && <span>{detail.errorMessage}</span>}
                </span>
              </div>
            )}
            <dl className="audit-detail-grid">
              <DetailValue label="开始时间">{timestamp(detail.createdAt)}</DetailValue>
              <DetailValue label="结束时间">{timestamp(detail.finishedAt)}</DetailValue>
              <DetailValue label="用户">{detail.userName || '—'}</DetailValue>
              <DetailValue label="角色">{detail.characterName || '—'}</DetailValue>
              <DetailValue label="供应商">{detail.supplierName || '—'}</DetailValue>
              <DetailValue label="模型">{detail.model || '—'}</DetailValue>
              <DetailValue label="协议">{detail.protocol}</DetailValue>
              <DetailValue label="HTTP 状态">{detail.httpStatus ?? '—'}</DetailValue>
              <DetailValue label="输入 Token">{count(detail.inputTokens)}</DetailValue>
              <DetailValue label="输出 Token">{count(detail.outputTokens)}</DetailValue>
            </dl>
            <dl className="audit-detail-identifiers">
              <DetailValue label="请求地址">
                <code>{detail.endpoint}</code>
              </DetailValue>
              <DetailValue label="对话 ID">
                <code>{detail.conversationId || '—'}</code>
              </DetailValue>
              <DetailValue label="消息请求 ID">
                <code>{detail.requestId || '—'}</code>
              </DetailValue>
            </dl>
            <BodyPanel
              title="请求内容"
              body={detail.requestBody}
              truncated={detail.requestTruncated}
              enabled={captureEnabled}
            />
            <BodyPanel
              title="响应内容"
              body={detail.responseBody}
              truncated={detail.responseTruncated}
              enabled={captureEnabled}
            />
            <div className="audit-detail-footer">
              <span>认证信息已脱敏；向量响应不展示向量本身。</span>
              <Button type="button" variant="secondary" onClick={() => setSelectedId(null)}>
                关闭详情
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
