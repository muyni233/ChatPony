'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  FilePenLine,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api } from '@/lib/client';
import type { User } from '@/lib/types';
import { Select } from '@/components/select';
import UserQuotaEditor, { type QuotaMember } from './UserQuotaEditor';
import QuotaResetDialog from './QuotaResetDialog';

type DirectoryUser = User & QuotaMember & { emailVerified?: boolean };
type DirectoryResponse = {
  users: DirectoryUser[];
  total?: number;
  page?: number;
  pageSize?: number;
};
type DirectoryPage = { users: DirectoryUser[]; total: number; page: number; pageSize: number };
const PAGE_SIZE = 50;
const windows = [
  { label: '5H', limit: 'quota5h', enabled: 'quota5hEnabled' },
  { label: '1D', limit: 'quota1d', enabled: 'quota1dEnabled' },
  { label: '7D', limit: 'quota7d', enabled: 'quota7dEnabled' },
] as const;

export default function UserDirectory({
  currentUser,
  revision = 0,
  onChanged,
}: {
  currentUser: User;
  revision?: number;
  onChanged: () => void;
}) {
  const [filters, setFilters] = useState({ query: '', page: 1 });
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<DirectoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [quotaEditor, setQuotaEditor] = useState<DirectoryUser | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        const parameters = new URLSearchParams({
          query: filters.query.trim(),
          page: String(filters.page),
          pageSize: String(PAGE_SIZE),
        });
        api<DirectoryResponse>(`/api/admin/users?${parameters}`, { signal: controller.signal })
          .then((data) => {
            if (!active) return;
            // Older response fixtures omit paging metadata and represent one page.
            setResult({
              users: data.users,
              total: data.total ?? data.users.length,
              page: data.page ?? 1,
              pageSize: data.pageSize ?? Math.max(PAGE_SIZE, data.users.length),
            });
            setError('');
          })
          .catch((cause) => {
            if (active && !controller.signal.aborted)
              setError(cause instanceof Error ? cause.message : '用户列表加载失败，请重试。');
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      filters.query.trim() ? 250 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filters, attempt, revision]);

  function update(next: Partial<typeof filters>) {
    setLoading(true);
    setError('');
    setResult(null);
    setFilters((previous) => ({ ...previous, page: 1, ...next }));
  }

  function refresh() {
    setLoading(true);
    setError('');
    setAttempt((value) => value + 1);
  }

  function changed(text: string) {
    setNotice({ text, error: false });
    refresh();
    onChanged();
  }

  async function mutate(
    member: DirectoryUser,
    payload: { role?: string; disabled?: boolean },
    success: string,
  ) {
    if (busy) return;
    setBusy(member.id);
    setNotice(null);
    try {
      await api(`/api/admin/users/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      changed(success);
    } catch (cause) {
      setNotice({
        text: cause instanceof Error ? cause.message : '用户设置更新失败，请重试。',
        error: true,
      });
    } finally {
      setBusy('');
    }
  }

  const users = result?.users ?? [];
  const currentPage = result?.page ?? filters.page;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? PAGE_SIZE)));

  return (
    <section className="admin-list-section admin-user-directory" aria-busy={loading}>
      <div className="admin-section-heading">
        <div>
          <h2>
            平台用户{' '}
            <span className="admin-count">{result ? result.total.toLocaleString() : '—'}</span>
          </h2>
          <p>搜索所有已注册账户，管理权限、配额与使用状态。</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          disabled={!!busy}
          onClick={() => setResetOpen(true)}
        >
          重置使用量
        </button>
      </div>
      <div className="admin-list-toolbar admin-user-toolbar">
        <label className="admin-search">
          <Search size={16} />
          <input
            type="search"
            value={filters.query}
            maxLength={100}
            disabled={!!busy}
            onChange={(event) => update({ query: event.target.value })}
            placeholder="搜索昵称、邮箱或用户 ID"
            aria-label="搜索用户"
          />
        </label>
        <button
          className="button button-ghost"
          type="button"
          disabled={loading || !!busy}
          onClick={refresh}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          刷新用户
        </button>
      </div>
      {notice && (
        <div
          className={`admin-notice${notice.error ? ' is-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <Activity size={17} /> : <CheckCircle2 size={17} />}
          <p>{notice.text}</p>
          <button
            className="admin-icon-button"
            type="button"
            aria-label="关闭用户操作提示"
            onClick={() => setNotice(null)}
          >
            <X size={17} />
          </button>
        </div>
      )}
      {error && (
        <div className="admin-notice is-error" role="alert">
          <p>{error}</p>
          <button
            className="button button-ghost"
            type="button"
            onClick={refresh}
            disabled={loading}
          >
            重新加载用户
          </button>
        </div>
      )}
      <div className="admin-user-records">
        {loading ? (
          <div className="audit-loading" role="status">
            <LoaderCircle className="spin" size={19} />
            正在读取用户列表…
          </div>
        ) : error ? null : users.length === 0 ? (
          <div className="admin-empty admin-empty-compact">
            <Search size={24} />
            <h3>没有找到匹配的用户</h3>
            <p>
              {filters.query.trim()
                ? '试试其他昵称、邮箱或用户 ID。'
                : '新注册的账户会出现在这里。'}
            </p>
          </div>
        ) : (
          <div className="admin-users-table-wrap">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>加入时间</th>
                  <th>账户权限</th>
                  <th>AI 配额</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                    <MoreHorizontal size={17} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <div className="admin-user-cell">
                        <span>{member.username.slice(0, 1).toUpperCase()}</span>
                        <div>
                          <strong title={member.id}>
                            {member.username}
                            {member.id === currentUser.id && <small>你</small>}
                          </strong>
                          <p>{member.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="admin-date-cell">
                      <time dateTime={member.createdAt}>
                        {new Date(member.createdAt).toLocaleDateString('zh-CN')}
                      </time>
                    </td>
                    <td>
                      <Select
                        aria-label={`${member.username} 的账户权限`}
                        value={member.role}
                        disabled={!!busy || member.id === currentUser.id}
                        onValueChange={(value) =>
                          void mutate(member, { role: value }, '用户权限已更新。')
                        }
                      >
                        <option value="user">普通用户</option>
                        <option value="admin">管理员</option>
                      </Select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="admin-user-quota"
                        aria-label={`${member.username} 的 AI 配额`}
                        title="调整配额"
                        disabled={!!busy}
                        onClick={() => setQuotaEditor(member)}
                      >
                        {windows.map((window) => (
                          <span key={window.label}>
                            <b>{window.label}</b>
                            {member[window.enabled] === false
                              ? '不限制'
                              : member[window.limit] == null
                                ? '站点默认'
                                : `${member[window.limit]!.toLocaleString()} 次`}
                          </span>
                        ))}
                        <FilePenLine size={14} />
                      </button>
                    </td>
                    <td>
                      <span
                        className={`admin-status-badge ${member.disabled || member.emailVerified === false ? '' : 'is-published'}`}
                      >
                        <Circle size={6} fill="currentColor" />
                        {member.disabled
                          ? '已停用'
                          : member.emailVerified === false
                            ? '待验证'
                            : '正常'}
                      </span>
                    </td>
                    <td>
                      <button
                        className={`button button-ghost ${member.disabled ? '' : 'admin-disable-button'}`}
                        type="button"
                        disabled={!!busy || member.id === currentUser.id}
                        title={member.id === currentUser.id ? '不能停用自己的账户' : undefined}
                        onClick={() =>
                          void mutate(
                            member,
                            { disabled: !member.disabled },
                            member.disabled ? '账户已重新启用。' : '账户已停用。',
                          )
                        }
                      >
                        {busy === member.id ? <LoaderCircle className="spin" size={15} /> : null}
                        {member.disabled ? '启用' : '停用'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <footer className="audit-pagination admin-user-pagination">
          <span aria-live="polite">
            {result
              ? `共 ${result.total.toLocaleString()} 位 · 第 ${currentPage} / ${pages} 页`
              : '每页显示 50 位用户'}
          </span>
          <div>
            <button
              className="button button-secondary"
              type="button"
              aria-label="上一页用户"
              disabled={loading || !!error || !!busy || currentPage <= 1}
              onClick={() => update({ page: currentPage - 1 })}
            >
              <ChevronLeft size={16} />
              <span>上一页</span>
            </button>
            <button
              className="button button-secondary"
              type="button"
              aria-label="下一页用户"
              disabled={loading || !!error || !!busy || currentPage >= pages}
              onClick={() => update({ page: currentPage + 1 })}
            >
              <span>下一页</span>
              <ChevronRight size={16} />
            </button>
          </div>
        </footer>
      </div>
      <p className="admin-bottom-note">
        <ShieldCheck size={14} />
        停用账户会阻止登录并保留历史数据。当前管理员不能修改自己的权限或停用自己。
      </p>
      {quotaEditor && (
        <UserQuotaEditor
          member={quotaEditor}
          onClose={() => setQuotaEditor(null)}
          onSaved={() => {
            setQuotaEditor(null);
            changed('用户配额已更新，已有用量保持不变。');
          }}
        />
      )}
      {resetOpen && (
        <QuotaResetDialog
          users={users}
          onClose={() => setResetOpen(false)}
          onReset={(count) => {
            setResetOpen(false);
            changed(`已为 ${count} 个账户重置所选窗口的使用量。`);
          }}
        />
      )}
    </section>
  );
}
