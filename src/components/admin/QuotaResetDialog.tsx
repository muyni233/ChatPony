'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Info, LoaderCircle, RotateCcw } from 'lucide-react';
import { Select } from '@/components/select';
import { api } from '@/lib/client';
import type { User } from '@/lib/types';
import Dialog from './Dialog';

type WindowKey = '5h' | '1d' | '7d' | 'all';
type ResetUser = Pick<User, 'id' | 'username' | 'email'>;
type SearchResponse = { users: ResetUser[]; total?: number; page?: number; pageSize?: number };
type SearchResult = { users: ResetUser[]; total: number; page: number; pageSize: number };
const windowNames: Record<WindowKey, string> = {
  '5h': '5 小时',
  '1d': '1 天',
  '7d': '7 天',
  all: '全部窗口',
};

export default function QuotaResetDialog({
  users,
  onClose,
  onReset,
}: {
  users: ResetUser[];
  onClose: () => void;
  onReset: (count: number) => void;
}) {
  const [scope, setScope] = useState('user');
  const [user, setUser] = useState<ResetUser | null>(null);
  const [filters, setFilters] = useState({ query: '', page: 1 });
  const [result, setResult] = useState<SearchResult>({
    users,
    total: users.length,
    page: 1,
    pageSize: 50,
  });
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [windowKey, setWindowKey] = useState<WindowKey>('5h');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (scope !== 'user' || confirming) return;
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setSearching(true);
        const parameters = new URLSearchParams({
          query: filters.query.trim(),
          page: String(filters.page),
          pageSize: '50',
        });
        api<SearchResponse>(`/api/admin/users?${parameters}`, { signal: controller.signal })
          .then((data) => {
            if (!active) return;
            setResult({
              users: data.users,
              total: data.total ?? data.users.length,
              page: data.page ?? 1,
              pageSize: data.pageSize ?? Math.max(50, data.users.length),
            });
            setSearchError('');
          })
          .catch((cause) => {
            if (active && !controller.signal.aborted)
              setSearchError(cause instanceof Error ? cause.message : '用户搜索失败，请重试。');
          })
          .finally(() => {
            if (active) setSearching(false);
          });
      },
      filters.query.trim() ? 250 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filters, attempt, scope, confirming]);

  function updateSearch(next: Partial<typeof filters>) {
    setUser(null);
    setSearching(true);
    setSearchError('');
    setFilters((previous) => ({ ...previous, page: 1, ...next }));
  }

  function chooseScope(value: string) {
    setScope(value);
    setUser(null);
    setError('');
    updateSearch({ query: '' });
  }

  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));

  async function reset() {
    if (busy || (scope === 'user' && !user)) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{
        windows: ('5h' | '1d' | '7d')[];
        resetUsers: number;
        resetAt: string;
      }>('/api/admin/quotas/reset', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          ...(scope === 'user' ? { userId: user!.id } : {}),
          window: windowKey,
        }),
      });
      window.dispatchEvent(new Event('chatpony:quota'));
      onReset(result.resetUsers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '使用量重置失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="重置对话用量"
      description="选择需要重新计算的用户与时间窗口。"
      onClose={onClose}
      busy={busy}
    >
      <div className="account-form admin-editor-form admin-quota-reset">
        {confirming ? (
          <div className="quota-reset-confirm">
            <span className="quota-reset-symbol">
              <RotateCcw size={22} />
            </span>
            <h3>确认重置所选使用量？</h3>
            <dl>
              <div>
                <dt>重置范围</dt>
                <dd>
                  {scope === 'all'
                    ? '全部用户（包括管理员与停用账户）'
                    : `${user?.username ?? '所选用户'} · ${user?.email ?? ''}`}
                </dd>
              </div>
              <div>
                <dt>时间窗口</dt>
                <dd>{windowNames[windowKey]}</dd>
              </div>
            </dl>
            <p>重置无法撤销。历史账本与审计记录仍会保留，配额开关和次数上限保持不变。</p>
          </div>
        ) : (
          <>
            <label className="field">
              <span>重置范围</span>
              <Select aria-label="重置范围" value={scope} onValueChange={chooseScope}>
                <option value="user">指定用户</option>
                <option value="all">全部用户</option>
              </Select>
            </label>
            {scope === 'user' && (
              <div className="quota-reset-user-search" aria-busy={searching}>
                <label className="field">
                  <span>搜索用户</span>
                  <input
                    type="search"
                    aria-label="搜索重置用户"
                    maxLength={100}
                    placeholder="输入昵称、邮箱或用户 ID"
                    value={filters.query}
                    onChange={(event) => updateSearch({ query: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>选择用户</span>
                  <Select
                    aria-label="选择重置用户"
                    value={user?.id ?? ''}
                    disabled={searching || !!searchError || !result.users.length}
                    onValueChange={(value) =>
                      setUser(result.users.find((item) => item.id === value) ?? null)
                    }
                  >
                    <option value="" disabled>
                      选择需要重置的用户
                    </option>
                    {result.users.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.username} · {item.email}
                      </option>
                    ))}
                  </Select>
                </label>
                {searchError ? (
                  <div className="quota-reset-search-error" role="alert">
                    <p>{searchError}</p>
                    <button
                      className="button button-ghost"
                      type="button"
                      onClick={() => {
                        setSearching(true);
                        setSearchError('');
                        setAttempt((value) => value + 1);
                      }}
                      disabled={searching}
                    >
                      重新搜索用户
                    </button>
                  </div>
                ) : (
                  <p className="field-hint quota-reset-search-status" role="status">
                    {searching
                      ? '正在搜索用户…'
                      : result.total
                        ? `找到 ${result.total.toLocaleString()} 位用户 · 第 ${result.page} / ${pages} 页`
                        : '没有找到匹配的用户，请调整关键词。'}
                  </p>
                )}
                {pages > 1 && !searchError && (
                  <div className="quota-reset-user-pages">
                    <button
                      className="button button-ghost"
                      type="button"
                      aria-label="上一组重置用户"
                      disabled={searching || result.page <= 1}
                      onClick={() => updateSearch({ page: result.page - 1 })}
                    >
                      <ChevronLeft size={14} />
                      上一页
                    </button>
                    <button
                      className="button button-ghost"
                      type="button"
                      aria-label="下一组重置用户"
                      disabled={searching || result.page >= pages}
                      onClick={() => updateSearch({ page: result.page + 1 })}
                    >
                      下一页
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
            )}
            <label className="field">
              <span>时间窗口</span>
              <Select
                aria-label="重置时间窗口"
                value={windowKey}
                onValueChange={(value) => setWindowKey(value as WindowKey)}
              >
                {Object.entries(windowNames).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          </>
        )}
        <div className="admin-quota-help">
          <Info size={16} />
          <p>正在生成的回复仍会占用次数，完成后计入重置后的用量。此次操作不会取消进行中的回复。</p>
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="admin-dialog-footer">
          <div>
            {confirming ? (
              <>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setError('');
                  }}
                  disabled={busy}
                >
                  返回选择
                </button>
                <button
                  className="button admin-danger-button"
                  type="button"
                  onClick={() => void reset()}
                  disabled={busy}
                >
                  {busy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}
                  {busy ? '正在重置…' : '确认重置使用量'}
                </button>
              </>
            ) : (
              <>
                <button className="button button-secondary" type="button" data-dialog-close>
                  取消
                </button>
                <button
                  className="button button-primary"
                  type="button"
                  disabled={scope === 'user' && (!user || searching || !!searchError)}
                  onClick={() => setConfirming(true)}
                >
                  查看重置确认
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </Dialog>
  );
}
