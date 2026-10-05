'use client';

import { useState } from 'react';
import { Clock3, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { useQuota } from '@/components/quota';
import type { QuotaWindow } from '@/lib/types';

function WindowUsage({
  label,
  duration,
  window,
}: {
  label: string;
  duration: string;
  window: QuotaWindow;
}) {
  const inactive = !window.enabled;
  const paused = window.enabled && window.limit === 0;
  const usedPercent = paused || inactive ? 0 : Math.min(100, (window.used / window.limit) * 100);
  const reservedPercent =
    paused || inactive ? 0 : Math.min(100 - usedPercent, (window.reserved / window.limit) * 100);
  const recovery = window.resetsAt ? new Date(window.resetsAt) : null;
  const recoveryText =
    recovery && !Number.isNaN(recovery.getTime())
      ? recovery.toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : null;
  return (
    <article
      className={`quota-window${window.remaining === 0 ? ' is-exhausted' : ''}${inactive ? ' is-inactive' : ''}`}
    >
      <header>
        <span className="quota-window-tag">{label}</span>
        <span>过去 {duration}</span>
      </header>
      <div className="quota-window-count">
        {inactive ? (
          <strong className="quota-inactive">不限制</strong>
        ) : paused ? (
          <strong className="quota-paused">已暂停</strong>
        ) : (
          <>
            <strong>{(window.remaining ?? 0).toLocaleString()}</strong>
            <span>次可用</span>
          </>
        )}
      </div>
      <div
        className="quota-meter"
        role="meter"
        aria-label={`${duration} AI 额度`}
        aria-valuemin={0}
        aria-valuemax={Math.max(1, window.limit)}
        aria-valuenow={inactive ? 0 : Math.min(window.limit, window.used + window.reserved)}
        aria-valuetext={
          inactive
            ? '此时间窗口未启用，不限制次数'
            : paused
              ? '管理员已暂停 AI 回复'
              : `已用 ${window.used} 次，进行中 ${window.reserved} 次，剩余 ${window.remaining} 次`
        }
      >
        <span className="quota-meter-used" style={{ width: `${usedPercent}%` }} />
        <span
          className="quota-meter-reserved"
          style={{ left: `${usedPercent}%`, width: `${reservedPercent}%` }}
        />
      </div>
      <div className="quota-window-detail">
        <span>
          已用 <b>{window.used.toLocaleString()}</b>
          {!inactive && <> / {window.limit.toLocaleString()}</>} 次
        </span>
        {window.reserved > 0 && (
          <span className="quota-reserved-note">进行中 {window.reserved.toLocaleString()} 次</span>
        )}
      </div>
      <p className="quota-window-recovery">
        <Clock3 size={12} />
        {inactive ? (
          '此时间窗口未启用'
        ) : paused ? (
          '请联系管理员调整额度'
        ) : recoveryText ? (
          <span>
            <time dateTime={window.resetsAt!}>{recoveryText}</time> 起恢复额度
          </span>
        ) : window.reserved > 0 ? (
          '当前回复完成后更新'
        ) : (
          '额度充足，等待下一次对话'
        )}
      </p>
    </article>
  );
}

export default function QuotaCard() {
  const { quota, error, refresh } = useQuota();
  const [refreshing, setRefreshing] = useState(false);
  async function reload() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <section className="settings-section quota-card" aria-labelledby="account-quota-heading">
      <div className="settings-section-heading quota-card-heading">
        <Sparkles size={20} />
        <div>
          <h2 id="account-quota-heading">AI 对话额度</h2>
          <p>已启用的时间窗口同时生效。</p>
        </div>
        <button
          className="admin-icon-button quota-refresh"
          type="button"
          aria-label="刷新对话额度"
          title="刷新额度"
          onClick={() => void reload()}
          disabled={refreshing}
        >
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {quota ? (
        <>
          <div className="quota-windows">
            <WindowUsage label="5H" duration="5 小时" window={quota.fiveHour} />
            <WindowUsage label="1D" duration="1 天" window={quota.oneDay} />
            <WindowUsage label="7D" duration="7 天" window={quota.sevenDay} />
          </div>
          <p className="quota-explanation">
            发起一次 AI 回复计 1 次，群聊同轮多个角色合计 1
            次。普通群消息不扣次数，失败或取消后返还。已用额度随时间恢复。
          </p>
        </>
      ) : (
        !error && (
          <div className="quota-loading" role="status">
            <LoaderCircle size={18} className="spin" />
            正在读取可用次数…
          </div>
        )
      )}
    </section>
  );
}
