'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock3, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client';
import type { QuotaStatus } from '@/lib/types';
import { useSession } from './session-provider';

export function useQuota() {
  const { user } = useSession();
  const userId = user?.id;
  const [result, setResult] = useState<{ userId: string; quota: QuotaStatus } | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const quota = await api<QuotaStatus>('/api/quota');
      setResult({ userId, quota });
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [userId]);
  const quota = result?.userId === userId ? (result?.quota ?? null) : null;
  useEffect(() => {
    const update = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') update();
    };
    update();
    window.addEventListener('chatpony:quota', update);
    window.addEventListener('chatpony:session', update);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('chatpony:quota', update);
      window.removeEventListener('chatpony:session', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (!quota) return;
    const times = [quota.fiveHour, quota.oneDay, quota.sevenDay]
      .filter((window) => window.enabled)
      .map((window) => window.resetsAt)
      .filter((value): value is string => !!value)
      .map(Date.parse)
      .filter(Number.isFinite);
    if (!times.length) return;
    const timer = window.setTimeout(
      () => {
        if (document.visibilityState === 'visible') void refresh();
      },
      Math.max(1000, Math.min(...times) - Date.now() + 200),
    );
    return () => window.clearTimeout(timer);
  }, [quota, refresh]);
  return { quota, error, refresh };
}

export function quotaUnavailable(quota: QuotaStatus | null) {
  return (
    !!quota &&
    [quota.fiveHour, quota.oneDay, quota.sevenDay].some(
      (window) => window.enabled && window.remaining === 0,
    )
  );
}

export function QuotaInline({
  quota,
  error,
  refresh,
  group = false,
}: ReturnType<typeof useQuota> & { group?: boolean }) {
  const blocked = quotaUnavailable(quota);
  const windows = quota
    ? [
        { label: '5H', title: '5 小时', ...quota.fiveHour },
        { label: '1D', title: '1 天', ...quota.oneDay },
        { label: '7D', title: '7 天', ...quota.sevenDay },
      ].filter((window) => window.enabled)
    : [];
  const paused = windows.some((window) => window.limit === 0);
  const blockingTimes = windows
    .filter((window) => window.remaining === 0 && window.resetsAt)
    .map((window) => Date.parse(window.resetsAt!));
  const recovery = blockingTimes.length
    ? new Date(Math.max(...blockingTimes)).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  return (
    <div className={`composer-quota ${blocked ? 'quota-exhausted' : ''}`}>
      <div className="quota-inline-row">
        <span className="quota-counting">
          <Clock3 size={12} />
          {quota && !windows.length
            ? 'AI 对话不限次数'
            : group
              ? '触发角色回应计 1 次'
              : '每次对话回合计 1 次'}
        </span>
        <div className="quota-inline-windows">
          {quota ? (
            windows.length ? (
              <>
                <span>剩余</span>
                {windows.map((window) => (
                  <span
                    key={window.label}
                    title={`${window.title}内已使用 ${window.used} 次，进行中 ${window.reserved} 次`}
                  >
                    {window.label} <b>{window.remaining}</b>
                    <span>/{window.limit}</span>
                  </span>
                ))}
              </>
            ) : (
              <span>未启用配额限制</span>
            )
          ) : (
            <span>{error ? '暂未读取额度' : '正在读取额度…'}</span>
          )}
          <button
            type="button"
            className="quota-refresh"
            aria-label="刷新剩余额度"
            title={error || '刷新剩余额度'}
            onClick={() => void refresh()}
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>
      {blocked && (
        <p className="quota-inline-notice" role="status">
          {paused
            ? '当前账户的 AI 配额已暂停，请联系管理员。'
            : `当前可用次数已用完${recovery ? `，预计 ${recovery} 恢复可用次数` : '，请稍后刷新'}。`}
          {group && '未提及角色的普通消息仍可发送。'}
        </p>
      )}
    </div>
  );
}
