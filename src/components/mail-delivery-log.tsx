'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileSearch,
  MailCheck,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Badge, Button, EmptyState, Field, Modal, Select } from '@/components/ui';
import { api } from '@/lib/client';
import type { MailDelivery, MailDeliveryList } from '@/lib/types';
const kinds: Record<MailDelivery['kind'], string> = {
  'connection-test': '连接测试',
  'test-email': '测试邮件',
  verification: '注册验证码',
};
const stages: Record<MailDelivery['stage'], string> = {
  configuration: '读取邮件配置',
  connection: '连接 SMTP 服务器',
  tls: 'TLS 加密协商',
  authentication: '身份鉴权',
  sender: '发件人校验',
  recipient: '收件人校验',
  data: '提交邮件内容',
  complete: '已完成',
  unknown: '阶段未知',
};
function timestamp(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
function duration(value: number | null) {
  if (value === null) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
function StatusBadge({ delivery }: { delivery: MailDelivery }) {
  const labels: Record<MailDelivery['status'], string> = {
    pending: '处理中',
    success: delivery.kind === 'connection-test' ? '连接通过' : '服务器已接受',
    failed: '失败',
    interrupted: '已中断',
  };
  return (
    <Badge
      tone={
        delivery.status === 'success' ? 'green' : delivery.status === 'failed' ? 'pink' : 'amber'
      }
    >
      {labels[delivery.status]}
    </Badge>
  );
}
function DetailValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function MailDeliveryLog({ refreshKey }: { refreshKey: number }) {
  const [result, setResult] = useState<MailDeliveryList | null>(null);
  const [status, setStatus] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<MailDelivery | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const idField = useRef<HTMLInputElement>(null);
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / 20));
  const activeFilters = !!status || !!search;
  const detail = selected
    ? result?.items.find((item) => item.id === selected.id) || selected
    : null;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (status) query.set('status', status);
    if (search) query.set('search', search);
    setLoading(true);
    setError('');
    api<MailDeliveryList>(`/api/admin/mail/deliveries?${query}`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(value.total / value.pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setResult(value);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : '无法读取邮件记录，请稍后刷新重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, status, search, reload, refreshKey]);

  function applySearch(event: FormEvent) {
    event.preventDefault();
    setSearch(searchDraft.trim());
    setPage(1);
    setReload((value) => value + 1);
  }
  function clearFilters() {
    setStatus('');
    setSearch('');
    setSearchDraft('');
    setPage(1);
  }
  function selectRecord(record: MailDelivery) {
    setSelected(record);
    setCopied(false);
    setCopyError('');
  }
  async function copyId() {
    if (!detail) return;
    setCopyError('');
    try {
      let completed = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(detail.id);
          completed = true;
        } catch {
          // A local HTTP origin or denied clipboard permission can use the visible field below.
        }
      }
      if (!completed) {
        const previous = document.activeElement as HTMLElement | null;
        const field = idField.current;
        if (!field) throw new Error('编号字段不可用');
        field.focus({ preventScroll: true });
        field.select();
        completed = document.execCommand('copy');
        previous?.focus({ preventScroll: true });
        if (!completed) throw new Error('剪贴板不可用');
      }
      setCopied(true);
    } catch {
      setCopyError('无法自动复制，请选中上方编号手动复制。');
    }
  }

  return (
    <section className="admin-mail-deliveries" aria-labelledby="mail-deliveries-title">
      <div className="admin-mail-log-heading">
        <div>
          <span className="admin-eyebrow">MAIL DELIVERY LOG</span>
          <h3 id="mail-deliveries-title">邮件发送记录</h3>
          <p>用用户提供的参考编号查询失败阶段、服务器响应和处理建议。</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          loading={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          {!loading && <RefreshCw size={15} />}
          刷新记录
        </Button>
      </div>
      <form className="admin-mail-log-filters" onSubmit={applySearch}>
        <Field label="发送状态">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="failed">失败</option>
            <option value="success">通过 / 已接受</option>
            <option value="pending">处理中</option>
            <option value="interrupted">已中断</option>
          </Select>
        </Field>
        <Field label="参考编号或收件邮箱" hint="邮箱已脱敏，可按显示的邮箱片段搜索。">
          <input
            type="search"
            maxLength={200}
            placeholder="粘贴用户提供的参考编号"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="secondary" loading={loading}>
          <Search size={15} />
          查询
        </Button>
      </form>
      {error && (
        <div className="admin-error admin-mail-log-error" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
        </div>
      )}
      <div className="admin-mail-log-results" aria-busy={loading}>
        <div className="admin-mail-log-count" aria-live="polite">
          <span>{result ? `共 ${result.total} 条记录` : '邮件处理记录'}</span>
          {loading && (
            <span>
              <RefreshCw size={12} className="spin" />
              正在加载
            </span>
          )}
          {activeFilters && (
            <button type="button" className="admin-text-link" onClick={clearFilters}>
              清除筛选
            </button>
          )}
        </div>
        {result?.items.length ? (
          <div className="admin-mail-log-table-wrap">
            <table className="admin-mail-log-table">
              <thead>
                <tr>
                  <th>时间 / 类型</th>
                  <th>收件邮箱</th>
                  <th>状态</th>
                  <th>处理结果</th>
                  <th>
                    <span className="admin-sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <time dateTime={item.createdAt}>{timestamp(item.createdAt)}</time>
                      <small>{kinds[item.kind]}</small>
                    </td>
                    <td>
                      <span>{item.recipient || '未发送邮件'}</span>
                      <small>{duration(item.durationMs)}</small>
                    </td>
                    <td>
                      <StatusBadge delivery={item} />
                    </td>
                    <td>
                      <p>{item.summary}</p>
                      <small className="admin-mail-log-id" title={item.id}>
                        编号 {item.id}
                      </small>
                    </td>
                    <td>
                      <button
                        className="admin-mail-detail-button"
                        type="button"
                        aria-label={`查看邮件记录 ${item.id}`}
                        onClick={() => selectRecord(item)}
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
          <div className="admin-loading" role="status">
            <RefreshCw className="spin" size={22} />
            <p>正在读取邮件记录…</p>
          </div>
        ) : (
          <EmptyState
            icon={activeFilters ? <FileSearch size={26} /> : <MailCheck size={26} />}
            title={
              error
                ? '邮件记录暂时无法读取'
                : activeFilters
                  ? '没有符合条件的邮件记录'
                  : '暂无邮件记录'
            }
            description={
              error
                ? '请查看上方错误信息，再点击刷新记录。'
                : activeFilters
                  ? '请检查参考编号，或清除筛选后重新查询。'
                  : '完成一次连接测试、测试发信或发送注册验证码后，记录会显示在这里。升级前未记录的错误无法恢复。'
            }
          />
        )}
        <div className="admin-mail-log-pagination">
          <span>
            第 {Math.min(page, pageCount)} / {pageCount} 页 · 每页 20 条
          </span>
          <div>
            <Button
              type="button"
              variant="ghost"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft size={15} />
              上一页
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={page >= pageCount || loading}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
              <ChevronRight size={15} />
            </Button>
          </div>
        </div>
      </div>
      <p className="admin-mail-log-footnote">
        {result ? `记录保留 ${result.retentionDays} 天。` : ''}
        邮箱地址及服务器响应中的敏感信息已脱敏，记录不包含验证码或邮件正文。服务器已接受不代表最终送达。
      </p>
      <Modal
        open={!!detail}
        onClose={() => setSelected(null)}
        title="邮件记录详情"
        description="检查邮件处理阶段与 SMTP 服务器返回结果。"
        wide
      >
        {detail && (
          <div className="admin-mail-detail">
            <div className="admin-mail-detail-status">
              <StatusBadge delivery={detail} />
              <span>{kinds[detail.kind]}</span>
              <strong>{duration(detail.durationMs)}</strong>
            </div>
            <p
              className={`admin-mail-detail-summary${detail.status === 'failed' || detail.status === 'interrupted' ? ' is-error' : ''}`}
            >
              {detail.summary}
            </p>
            <div className="admin-mail-detail-reference">
              <Field label="参考编号">
                <input
                  ref={idField}
                  value={detail.id}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
              </Field>
              <Button type="button" variant="secondary" onClick={() => void copyId()}>
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? '已复制' : '复制编号'}
              </Button>
            </div>
            {copyError && (
              <p className="admin-mail-copy-error" role="alert">
                {copyError}
              </p>
            )}
            <dl className="admin-mail-detail-grid">
              <DetailValue label="开始时间">{timestamp(detail.createdAt)}</DetailValue>
              <DetailValue label="结束时间">{timestamp(detail.finishedAt)}</DetailValue>
              <DetailValue label="处理阶段">{stages[detail.stage]}</DetailValue>
              <DetailValue label="SMTP 命令">
                <code>{detail.command || '—'}</code>
              </DetailValue>
              <DetailValue label="SMTP 状态码">
                <code>{detail.smtpCode ?? '—'}</code>
              </DetailValue>
              <DetailValue label="增强状态码">
                <code>{detail.enhancedStatus || '—'}</code>
              </DetailValue>
              <DetailValue label="错误代码">
                <code>{detail.code || '—'}</code>
              </DetailValue>
              <DetailValue label="SMTP 服务器">
                <code>{detail.smtpHost ? `${detail.smtpHost}:${detail.smtpPort}` : '未配置'}</code>
              </DetailValue>
              <DetailValue label="发件邮箱">{detail.fromEmail || '—'}</DetailValue>
              <DetailValue label="收件邮箱">{detail.recipient || '未发送邮件'}</DetailValue>
            </dl>
            <div className="admin-mail-detail-response">
              <h4>
                服务器响应 <span>已脱敏</span>
              </h4>
              <pre>
                {detail.response ||
                  '没有可用的 SMTP 响应。请结合处理阶段、错误代码和下方建议排查。'}
              </pre>
            </div>
            <div className="admin-mail-detail-hint">
              <h4>处理建议</h4>
              <p>{detail.hint || '请结合记录中的处理阶段和服务器响应检查 SMTP 配置。'}</p>
            </div>
            {detail.status === 'success' && (
              <p className="admin-mail-detail-notice">
                {detail.kind === 'connection-test'
                  ? '本次仅验证连接和鉴权，没有发送邮件。请使用“发送测试邮件”继续检查发件权限。'
                  : 'SMTP 服务器已接受邮件，请检查收件箱与垃圾邮件；本记录不能确认邮件最终送达。'}
              </p>
            )}
            <div className="admin-mail-detail-footer">
              <span>排查问题时可提供参考编号。</span>
              <Button type="button" variant="secondary" onClick={() => setSelected(null)}>
                关闭详情
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
