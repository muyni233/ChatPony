'use client';

import Link from 'next/link';
import { ArrowUpRight, CircleHelp, Clock3, Gauge } from 'lucide-react';
import { useApp } from './app-provider';
import { Tooltip } from './ui';
import type { QuotaWindow } from '@/lib/types';

export function QuotaCard({ expanded = false }: { expanded?: boolean }) {
  const { data, openAuth } = useApp();
  return (
    <section className={`card quota-card ${expanded ? 'quota-expanded' : ''}`}>
      <div className="card-heading">
        <h3>
          <Gauge size={17} aria-hidden="true" />
          额度
        </h3>
        <Tooltip
          content="每次成功的角色回复计 1 次，5 小时和 7 天两个滚动窗口同时生效。请求失败不计入。"
          side="left"
        >
          <span className="quota-help" tabIndex={0} aria-label="额度计算说明">
            <CircleHelp size={15} />
          </span>
        </Tooltip>
      </div>
      <QuotaLine label="5 小时" period="5h" quota={data?.quota?.fiveHour} />
      <QuotaLine label="7 天" period="7d" quota={data?.quota?.sevenDay} />
      <div className="quota-bottom">
        {data?.user ? (
          <>
            <span />
            {!expanded && (
              <Link href="/settings" className="card-link">
                查看详情
                <ArrowUpRight size={13} />
              </Link>
            )}
          </>
        ) : (
          <button className="text-button" onClick={() => openAuth()}>
            登录后查看额度
            <ArrowUpRight size={13} />
          </button>
        )}
      </div>
      {expanded && <p className="field-hint">群聊中每个角色的回复分别计数。额度由管理员设置。</p>}
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
          {label}
        </span>
        <span>
          {quota ? (
            <>
              <strong>{quota.remaining}</strong>
              <small> / {quota.limit}</small>
            </>
          ) : (
            <small>未登录</small>
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
        <span
          className={percent >= 90 ? 'quota-critical' : percent >= 70 ? 'quota-warning' : ''}
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>
      {quota?.resetsAt && (
        <small className="quota-reset">
          恢复于{' '}
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
