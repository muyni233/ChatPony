'use client';

import Link from 'next/link';
import { ArrowUpRight, CircleHelp, Clock3, Leaf } from 'lucide-react';
import { useApp } from './app-provider';
import type { QuotaWindow } from '@/lib/types';

export function QuotaCard({ expanded = false }: { expanded?: boolean }) {
  const { data, openAuth } = useApp();
  return (
    <section className={`paper-card quota-card ${expanded ? 'quota-expanded' : ''}`}>
      <div className="card-heading">
        <h3>
          <Leaf size={18} />
          对话额度
        </h3>
        <span title="每次成功的角色响应计为 1 次调用。两个滚动窗口同时生效。">
          <CircleHelp size={16} />
        </span>
      </div>
      <p className="card-description">为每一次灵感，留一点空间。</p>
      <QuotaLine label="5 小时" period="5h" quota={data?.quota?.fiveHour} />
      <QuotaLine label="7 天" period="7d" quota={data?.quota?.sevenDay} />
      <div className="quota-bottom">
        {data?.user ? (
          <>
            <span>
              <span className="tiny-dot" />
              按成功调用次数计算
            </span>
            {!expanded && (
              <Link href="/settings">
                查看详情
                <ArrowUpRight size={13} />
              </Link>
            )}
          </>
        ) : (
          <button className="text-button" onClick={() => openAuth()}>
            登录后查看我的额度
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
      {expanded && (
        <p className="field-hint">
          5 小时和 7
          天均为滚动窗口。群聊中每位角色的每次成功响应分别计数。请求失败不扣除额度；管理员可调整或重置额度。
        </p>
      )}
    </section>
  );
}
function QuotaLine({
  label,
  period,
  quota,
}: {
  label: string;
  period: string;
  quota?: QuotaWindow;
}) {
  const percent = quota && quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 0;
  return (
    <div className={`quota-line quota-${period}`}>
      <div className="quota-line-heading">
        <span>
          <Clock3 size={13} />
          {label}额度
        </span>
        <span>
          {quota ? (
            <>
              <strong>{quota.remaining}</strong>
              <small> / {quota.limit} 次可用</small>
            </>
          ) : (
            <small>等待登录</small>
          )}
        </span>
      </div>
      <div
        className="quota-track"
        role="progressbar"
        aria-label={`${label}已使用额度`}
        aria-valuenow={quota?.used || 0}
        aria-valuemin={0}
        aria-valuemax={Math.max(1, quota?.limit || 1)}
      >
        <span style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      {quota?.resetsAt && (
        <small className="quota-reset">
          下次释放{' '}
          {new Date(quota.resetsAt).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </small>
      )}
    </div>
  );
}
