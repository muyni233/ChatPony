'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownUp,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Select } from '@/components/select';
import { api } from '@/lib/client';
import type { AuditEntry, AuditResponse, AuditStatus } from '@/lib/types';
import Dialog from './Dialog';
import { protocolNames } from './ProviderEditor';

const statusNames: Record<AuditStatus, string> = {
  pending: '进行中',
  success: '成功',
  error: '失败',
  cancelled: '已取消',
  rejected: '已拦截',
  replayed: '幂等重放',
};
const number = (value: number) => value.toLocaleString('zh-CN');

function elapsed(value: number | null) {
  if (value === null) return '—';
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s`;
}

function localTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function Status({ status }: { status: AuditStatus }) {
  return (
    <span className={`audit-status is-${status}`}>
      <span />
      {statusNames[status]}
    </span>
  );
}

function Trend({ days }: { days: AuditResponse['stats']['daily'] }) {
  const maximum = Math.max(1, ...days.map((day) => day.requests));
  return (
    <section className="audit-trend" aria-labelledby="audit-trend-heading">
      <header>
        <div>
          <h3 id="audit-trend-heading">每日请求量</h3>
          <span>按 UTC 日期汇总</span>
        </div>
        <div className="audit-chart-legend">
          <span>
            <i className="is-success" />
            成功
          </span>
          <span>
            <i className="is-error" />
            失败
          </span>
          <span>
            <i />
            其他
          </span>
        </div>
      </header>
      {days.some((day) => day.requests > 0) ? (
        <>
          <div
            className="audit-chart"
            style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
          >
            {days.map((day) => (
              <div
                className="audit-chart-day"
                key={day.date}
                tabIndex={0}
                role="img"
                aria-label={`${day.date} UTC：${day.requests} 次请求，成功 ${day.success} 次，失败 ${day.error} 次`}
              >
                <div
                  className="audit-chart-bar"
                  style={{
                    height: `${Math.max(day.requests ? 3 : 0, (day.requests / maximum) * 100)}%`,
                  }}
                >
                  <span
                    className="audit-chart-success"
                    style={{ height: `${day.requests ? (day.success / day.requests) * 100 : 0}%` }}
                  />
                  <span
                    className="audit-chart-error"
                    style={{
                      bottom: `${day.requests ? (day.success / day.requests) * 100 : 0}%`,
                      height: `${day.requests ? (day.error / day.requests) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className="audit-chart-tooltip" aria-hidden="true">
                  <strong>{day.date} · UTC</strong>
                  <span>{number(day.requests)} 次请求</span>
                  <span>
                    成功 {number(day.success)} · 失败 {number(day.error)}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="audit-chart-axis">
            <span>{days[0]?.date}</span>
            <span>每日最多 {number(maximum)} 次</span>
            <span>{days.at(-1)?.date}</span>
          </div>
        </>
      ) : (
        <div className="audit-chart-empty">
          <Activity size={22} strokeWidth={1.3} />
          <span>所选时间内还没有请求记录</span>
        </div>
      )}
    </section>
  );
}

function Detail({ entry, onClose }: { entry: AuditEntry; onClose: () => void }) {
  return (
    <Dialog title="请求详情" description="查看请求结果、执行信息与用量。" onClose={onClose} wide>
      <div className="audit-detail">
        <div className="audit-detail-summary">
          <Status status={entry.status} />
          <span>{entry.kind === 'group' ? '多角色群聊' : '角色私聊'}</span>
          <span>{entry.quotaCharged ? '已扣除 1 次' : '未扣除次数'}</span>
        </div>
        <dl className="audit-detail-grid">
          <div className="audit-detail-full">
            <dt>请求 ID</dt>
            <dd>
              <code>{entry.id}</code>
            </dd>
          </div>
          <div>
            <dt>发起时间</dt>
            <dd>
              <time dateTime={entry.time}>
                {new Date(entry.time).toLocaleString('zh-CN', { hour12: false })}
              </time>
            </dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>
              {entry.finishedAt ? (
                <time dateTime={entry.finishedAt}>
                  {new Date(entry.finishedAt).toLocaleString('zh-CN', { hour12: false })}
                </time>
              ) : (
                '尚未结束'
              )}
            </dd>
          </div>
          <div>
            <dt>用户</dt>
            <dd>
              {entry.username || '未记录名称'}
              <small>{entry.userId}</small>
            </dd>
          </div>
          <div>
            <dt>会话</dt>
            <dd>
              {entry.conversationTitle || '未记录标题'}
              <small>{entry.conversationId || '—'}</small>
            </dd>
          </div>
          <div className="audit-detail-full">
            <dt>参与角色</dt>
            <dd>{entry.characterNames.length ? entry.characterNames.join('、') : '未记录角色'}</dd>
          </div>
          <div>
            <dt>模型服务</dt>
            <dd>
              {entry.providerName || '未记录接口'}
              {entry.providerId && <small>{entry.providerId}</small>}
            </dd>
          </div>
          <div>
            <dt>协议与模型</dt>
            <dd>
              {entry.protocol ? protocolNames[entry.protocol] : '—'}
              {entry.model && <small>{entry.model}</small>}
            </dd>
          </div>
          <div>
            <dt>执行耗时</dt>
            <dd>{elapsed(entry.durationMs)}</dd>
          </div>
          <div>
            <dt>回复与输出</dt>
            <dd>
              {number(entry.replyCount)} 条回复 · {number(entry.outputCharacters)} 字符
            </dd>
          </div>
        </dl>
        {(entry.errorCode || entry.errorMessage) && (
          <div className="audit-detail-error">
            <span>处理结果 {entry.errorCode && <code>{entry.errorCode}</code>}</span>
            <p>{entry.errorMessage || '此请求未完成。'}</p>
          </div>
        )}
        {entry.status === 'replayed' && (
          <p className="audit-detail-note">这次请求返回了已有结果，没有再次扣除对话次数。</p>
        )}
        <p className="audit-detail-note">
          <Info size={13} />
          审计记录仅包含元数据与脱敏错误，不包含对话正文或 API 密钥。
        </p>
      </div>
      <footer className="admin-dialog-footer">
        <span>时间按当前设备所在时区显示</span>
        <div>
          <button className="button button-secondary" type="button" data-dialog-close>
            关闭详情
          </button>
        </div>
      </footer>
    </Dialog>
  );
}

export default function RequestAudit({ refreshVersion = 0 }: { refreshVersion?: number }) {
  const [filters, setFilters] = useState({ days: '7', status: 'all', query: '', page: 1 });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        const parameters = new URLSearchParams({
          days: filters.days,
          status: filters.status,
          query: filters.query.trim(),
          page: String(filters.page),
          pageSize: '20',
        });
        api<AuditResponse>(`/api/admin/audit?${parameters}`, { signal: controller.signal })
          .then((data) => {
            if (active) {
              setResult(data);
              setError('');
            }
          })
          .catch((cause) => {
            if (active && !controller.signal.aborted)
              setError(cause instanceof Error ? cause.message : '请求审计加载失败，请重试。');
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      filters.query ? 250 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filters, revision, refreshVersion]);

  function update(next: Partial<typeof filters>) {
    setLoading(true);
    setError('');
    setResult(null);
    setFilters((previous) => ({ ...previous, page: 1, ...next }));
  }
  function refresh() {
    setLoading(true);
    setError('');
    setRevision((value) => value + 1);
  }
  const stats = result?.stats;
  const entries = result?.entries;
  const pages = Math.max(1, Math.ceil((entries?.total ?? 0) / (entries?.pageSize ?? 20)));
  const successRate = stats?.requests
    ? `${((stats.success / stats.requests) * 100).toFixed(1)}%`
    : '—';

  return (
    <section className="audit-page admin-list-section" aria-busy={loading}>
      <div className="admin-section-heading">
        <div>
          <h2>请求审计</h2>
          <p>查看调用结果、对话用量与服务运行情况。</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          刷新记录
        </button>
      </div>
      <div className="audit-filters">
        <label>
          <span>时间范围</span>
          <Select
            aria-label="审计时间范围"
            value={filters.days}
            onValueChange={(days) => update({ days })}
            variant="compact"
          >
            <option value="1">近 24 小时</option>
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
          </Select>
        </label>
        <label>
          <span>请求状态</span>
          <Select
            aria-label="审计请求状态"
            value={filters.status}
            onValueChange={(status) => update({ status })}
            variant="compact"
          >
            <option value="all">全部状态</option>
            {Object.entries(statusNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label className="admin-search audit-search">
          <Search size={16} />
          <input
            type="search"
            value={filters.query}
            onChange={(event) => update({ query: event.target.value })}
            maxLength={100}
            aria-label="搜索请求"
            placeholder="搜索用户、角色、模型或请求 ID"
          />
        </label>
      </div>
      {result && result.filters.days < Number(filters.days) && (
        <p className="audit-range-note">
          <Info size={13} />
          当前仅保留 {result.retentionDays} 天记录，已按可用保留期统计。
        </p>
      )}
      {error && (
        <div className="admin-notice is-error" role="alert">
          <p>{error}</p>
          <button className="button button-ghost" type="button" onClick={refresh}>
            重新加载
          </button>
        </div>
      )}
      <div className="audit-stat-grid">
        {[
          {
            label: '请求总数',
            value: stats ? number(stats.requests) : '—',
            note: '含重放与被拦截的请求',
            icon: ArrowDownUp,
          },
          {
            label: '成功率',
            value: successRate,
            note: '成功请求 / 当前筛选请求',
            icon: CheckCircle2,
          },
          {
            label: '扣除次数',
            value: stats ? number(stats.chargedTurns) : '—',
            note: '实际成功的对话回合',
            icon: Activity,
          },
          {
            label: '平均耗时',
            value:
              stats && stats.success + stats.error + stats.cancelled > 0
                ? elapsed(stats.averageDurationMs)
                : '—',
            note: '成功、失败和取消请求',
            icon: Clock3,
          },
        ].map((item) => (
          <article className="audit-stat" key={item.label}>
            <header>
              <span>{item.label}</span>
              <item.icon size={15} />
            </header>
            <strong>{item.value}</strong>
            <small>{item.note}</small>
          </article>
        ))}
      </div>
      <Trend days={stats?.daily ?? []} />
      <div className="audit-records">
        <header>
          <h3>
            请求记录 <span>{entries ? number(entries.total) : '—'}</span>
          </h3>
          <span>统计与记录均按当前筛选</span>
        </header>
        {loading ? (
          <div className="audit-loading" role="status">
            <LoaderCircle className="spin" size={19} />
            正在读取请求记录…
          </div>
        ) : !entries?.items.length ? (
          <div className="admin-empty admin-empty-compact">
            <Search size={25} strokeWidth={1.3} />
            <h3>暂无匹配的请求</h3>
            <p>
              {filters.query || filters.status !== 'all'
                ? '试着调整关键词、状态或时间范围。'
                : '平台开始生成对话后，请求结果会出现在这里。'}
            </p>
          </div>
        ) : (
          <div className="audit-table-wrap">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>时间 / 用户</th>
                  <th>角色 / 会话</th>
                  <th>模型</th>
                  <th>结果</th>
                  <th>耗时 / 次数</th>
                  <th>
                    <span className="sr-only">查看详情</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <time dateTime={entry.time}>{localTime(entry.time)}</time>
                      <small>{entry.username || '未记录名称'}</small>
                    </td>
                    <td>
                      <span className="audit-cell-title" title={entry.characterNames.join('、')}>
                        {entry.characterNames.join('、') || '未记录角色'}
                      </span>
                      <small title={entry.conversationTitle}>
                        {entry.kind === 'group' ? '群聊' : '私聊'} ·{' '}
                        {entry.conversationTitle || '未记录会话'}
                      </small>
                    </td>
                    <td>
                      <span className="audit-cell-title" title={entry.model ?? undefined}>
                        {entry.model || '—'}
                      </span>
                      <small>{entry.providerName || '未记录接口'}</small>
                    </td>
                    <td>
                      <Status status={entry.status} />
                    </td>
                    <td>
                      <span>{elapsed(entry.durationMs)}</span>
                      <small>{entry.quotaCharged ? '扣除 1 次' : '未扣除'}</small>
                    </td>
                    <td>
                      <button
                        className="admin-icon-button"
                        type="button"
                        aria-label={`查看请求 ${entry.id} 的详情`}
                        onClick={() => setSelected(entry)}
                      >
                        <ArrowRight size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <footer className="audit-pagination">
          <span>
            第 {entries?.page ?? 1} / {pages} 页 · 每页 20 条
          </span>
          <div>
            <button
              className="button button-secondary"
              type="button"
              aria-label="上一页请求"
              onClick={() => update({ page: Math.max(1, filters.page - 1) })}
              disabled={loading || filters.page <= 1}
            >
              <ChevronLeft size={16} />
              <span>上一页</span>
            </button>
            <button
              className="button button-secondary"
              type="button"
              aria-label="下一页请求"
              onClick={() => update({ page: filters.page + 1 })}
              disabled={loading || filters.page >= pages}
            >
              <span>下一页</span>
              <ChevronRight size={16} />
            </button>
          </div>
        </footer>
      </div>
      <p className="admin-bottom-note audit-retention-note">
        <Info size={14} />
        {result
          ? `审计记录保留 ${result.retentionDays} 天，过期自动清理。`
          : '审计保留时间由站点设置管理。'}
        记录不包含对话正文或密钥。
      </p>
      {selected && <Detail entry={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}
