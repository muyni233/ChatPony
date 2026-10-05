'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Megaphone,
  Pin,
} from 'lucide-react';
import { api } from '@/lib/client';
import type { Announcement, AnnouncementList } from '@/lib/announcements-types';
import Dialog from './admin/Dialog';

function Detail({ id, onClose, onRead }: { id: string; onClose: () => void; onRead: () => void }) {
  const [entry, setEntry] = useState<Announcement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    api<{ announcement: Announcement }>(`/api/announcements/${id}`, { signal: controller.signal })
      .then(async (result) => {
        if (!active) return;
        setEntry(result.announcement);
        setError('');
        setLoading(false);
        try {
          await api(`/api/announcements/${id}/read`, {
            method: 'POST',
            body: JSON.stringify({ revision: result.announcement.revision }),
            signal: controller.signal,
          });
          if (active) {
            setReadError('');
            onRead();
          }
        } catch (cause) {
          if (active)
            setReadError(
              cause instanceof Error ? cause.message : '未能同步阅读状态，请重新打开公告。',
            );
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : '公告加载失败，请重试。');
          setLoading(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [id, attempt, onRead]);
  function retry() {
    setLoading(true);
    setError('');
    setReadError('');
    setAttempt((value) => value + 1);
  }
  return (
    <Dialog
      title={entry?.title || '公告详情'}
      eyebrow="CHATPONY / ANNOUNCEMENTS"
      onClose={onClose}
      wide
    >
      <div className="announcement-detail">
        {loading ? (
          <div className="audit-loading" role="status">
            <LoaderCircle size={20} className="spin" />
            正在打开公告…
          </div>
        ) : error ? (
          <div className="announcement-read-error" role="alert">
            <p>{error}</p>
            <button className="button button-secondary" type="button" onClick={retry}>
              重新加载公告
            </button>
          </div>
        ) : (
          entry && (
            <>
              <div className="announcement-detail-meta">
                {entry.pinned && (
                  <span>
                    <Pin size={13} />
                    置顶公告
                  </span>
                )}
                <time dateTime={entry.publishedAt || entry.updatedAt}>
                  {new Date(entry.publishedAt || entry.updatedAt).toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </time>
                <span>ChatPony 管理团队</span>
              </div>
              <div className="announcement-body">{entry.body}</div>
              {readError && (
                <div className="announcement-read-error" role="alert">
                  <p>{readError}</p>
                  <button className="button button-secondary" type="button" onClick={retry}>
                    载入最新公告
                  </button>
                </div>
              )}
            </>
          )
        )}
      </div>
      <footer className="admin-dialog-footer">
        <span>来自平台的一份消息</span>
        <div>
          <button className="button button-primary" type="button" data-dialog-close>
            关闭公告
          </button>
        </div>
      </footer>
    </Dialog>
  );
}

export default function Announcements() {
  const [data, setData] = useState<AnnouncementList | null>(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    api<AnnouncementList>(`/api/announcements?page=${page}&pageSize=12`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (active) {
          setData(result);
          setError('');
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '暂时无法读取公告。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [page, revision]);
  const read = useCallback(() => {
    setRevision((value) => value + 1);
    window.dispatchEvent(new Event('chatpony:announcements'));
  }, []);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 12));
  const unread = data?.unreadCount ?? 0;
  return (
    <div className="announcements-page page-enter">
      <header className="page-header">
        <div>
          <p className="eyebrow">NOTES FROM CHATPONY</p>
          <h1>
            站点公告 <span className="heading-spark">✧</span>
          </h1>
          <p>平台的更新、活动与使用提醒，都在这里。</p>
        </div>
        {data && (
          <span className={`announcement-read-summary${unread ? ' has-unread' : ''}`}>
            {unread ? (
              <>
                <span />
                {unread} 条未读
              </>
            ) : (
              <>
                <Check size={14} />
                已全部阅读
              </>
            )}
          </span>
        )}
      </header>
      {error && (
        <div className="admin-notice is-error" role="alert">
          <p>{error}</p>
          <button
            className="button button-ghost"
            type="button"
            onClick={() => {
              setLoading(true);
              setRevision((value) => value + 1);
            }}
          >
            重新加载
          </button>
        </div>
      )}
      {loading ? (
        <div className="audit-loading" role="status">
          <LoaderCircle size={20} className="spin" />
          正在读取公告…
        </div>
      ) : error ? null : !data?.items.length ? (
        <div className="empty-state announcement-empty">
          <span className="empty-symbol">
            <Megaphone size={28} strokeWidth={1.3} />
          </span>
          <h2>暂时还没有公告</h2>
          <p>有新的平台消息时，会在这里与你见面。</p>
        </div>
      ) : (
        <section className="announcements-board" aria-label="已发布公告">
          <div className="announcements-board-heading">
            <span>来自平台的消息</span>
            <small>{data.total} 条公告</small>
          </div>
          {data.items.map((entry) => {
            const date = new Date(entry.publishedAt || entry.updatedAt);
            return (
              <button
                className={`announcement-row${entry.readAt ? ' is-read' : ' is-unread'}`}
                type="button"
                aria-label={`阅读公告：${entry.title}`}
                key={entry.id}
                data-announcement-id={entry.id}
                onClick={() => setSelected(entry.id)}
              >
                <span className="announcement-date">
                  <strong>{String(date.getDate()).padStart(2, '0')}</strong>
                  <small>
                    {date.getMonth() + 1} 月 · {date.getFullYear()}
                  </small>
                </span>
                <span className="announcement-row-content">
                  <span className="announcement-row-labels">
                    {entry.pinned && (
                      <span className="announcement-pin-label">
                        <Pin size={12} />
                        置顶
                      </span>
                    )}
                    {entry.readAt ? (
                      <span className="announcement-read-label">已读</span>
                    ) : (
                      <span className="announcement-unread-label">
                        <span />
                        未读
                      </span>
                    )}
                  </span>
                  <strong>{entry.title}</strong>
                  <span className="announcement-excerpt">{entry.body}</span>
                </span>
                <ArrowUpRight size={20} strokeWidth={1.5} />
              </button>
            );
          })}
        </section>
      )}
      {data && data.total > 12 && (
        <footer className="announcement-pagination">
          <span>
            第 {data.page} / {pages} 页
          </span>
          <div>
            <button
              className="button button-secondary"
              type="button"
              aria-label="上一页公告"
              disabled={loading || data.page <= 1}
              onClick={() => {
                setLoading(true);
                setPage(data.page - 1);
              }}
            >
              <ChevronLeft size={16} />
              上一页
            </button>
            <button
              className="button button-secondary"
              type="button"
              aria-label="下一页公告"
              disabled={loading || data.page >= pages}
              onClick={() => {
                setLoading(true);
                setPage(data.page + 1);
              }}
            >
              下一页
              <ChevronRight size={16} />
            </button>
          </div>
        </footer>
      )}
      {selected && <Detail id={selected} onClose={() => setSelected(null)} onRead={read} />}
    </div>
  );
}
