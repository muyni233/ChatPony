'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  LoaderCircle,
  Megaphone,
  Pin,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { Select } from '@/components/select';
import { api, ApiError } from '@/lib/client';
import type { Announcement, AnnouncementList } from '@/lib/announcements-types';
import Dialog from './Dialog';

function Editor({
  entry,
  onClose,
  onSaved,
  onReload,
}: {
  entry: Announcement | null;
  onClose: () => void;
  onSaved: () => void;
  onReload: () => void;
}) {
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [status, setStatus] = useState<'draft' | 'published'>(entry?.status ?? 'draft');
  const [pinned, setPinned] = useState(entry?.pinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || !body.trim()) {
      setError('请填写公告标题与正文。');
      return;
    }
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      await api(entry ? `/api/admin/announcements/${entry.id}` : '/api/admin/announcements', {
        method: entry ? 'PATCH' : 'POST',
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          status,
          pinned,
          ...(entry ? { revision: entry.revision } : {}),
        }),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公告保存失败，请重试。');
      setConflict(cause instanceof ApiError && cause.code === 'ANNOUNCEMENT_CHANGED');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={entry ? '编辑公告' : '新建公告'}
      description="发布平台更新、活动消息与使用提醒。"
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="account-form admin-editor-form announcement-editor" onSubmit={save}>
        <label className="field" htmlFor="announcement-title">
          <span>
            公告标题 <small>{title.length} / 120</small>
          </span>
          <input
            id="announcement-title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={120}
            disabled={busy}
            placeholder="为这条公告写一个清晰的标题"
          />
        </label>
        <label className="field" htmlFor="announcement-body">
          <span>
            公告正文 <small>{body.length.toLocaleString()} / 12,000</small>
          </span>
          <textarea
            id="announcement-body"
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={9}
            required
            maxLength={12000}
            disabled={busy}
            placeholder="写下需要告知用户的内容…"
            aria-describedby="announcement-body-hint"
          />
          <small className="field-hint" id="announcement-body-hint">
            以纯文本显示，保留换行。正文中的 HTML 和 Markdown 不会被执行或解析。
          </small>
        </label>
        <div className="announcement-publish-options">
          <label className="field" htmlFor="announcement-status">
            <span>发布状态</span>
            <Select
              id="announcement-status"
              value={status}
              onValueChange={(value) => setStatus(value as 'draft' | 'published')}
              disabled={busy}
            >
              <option value="draft">草稿</option>
              <option value="published">已发布</option>
            </Select>
          </label>
          <label className="admin-checkbox">
            <input
              id="announcement-pinned"
              name="pinned"
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
              disabled={busy}
            />
            <span>
              <strong>置顶公告</strong>
              <small>发布后优先显示在公告列表顶部。</small>
            </span>
          </label>
        </div>
        {entry && <p className="admin-save-note">更新已发布公告后，用户需要重新阅读新版本。</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <button className="button button-secondary" type="button" onClick={onReload}>
            返回列表并刷新
          </button>
        )}
        <footer className="admin-dialog-footer">
          <span>{status === 'published' ? '保存后对所有用户可见' : '草稿仅管理员可见'}</span>
          <div>
            <button
              className="button button-secondary"
              type="button"
              data-dialog-close
              disabled={busy}
            >
              取消
            </button>
            <button className="button button-primary" type="submit" disabled={busy || conflict}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              {busy ? '保存中…' : '保存公告'}
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}

export default function AnnouncementManager({ refreshVersion = 0 }: { refreshVersion?: number }) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<AnnouncementList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [editor, setEditor] = useState<Announcement | null | undefined>(undefined);
  const [deletion, setDeletion] = useState<Announcement | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    api<AnnouncementList>(`/api/admin/announcements?page=${page}&pageSize=12`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (active) {
          setData(result);
          setError('');
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '公告列表加载失败。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [page, revision, refreshVersion]);
  function refresh() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  function changed(message: string) {
    setNotice(message);
    window.dispatchEvent(new Event('chatpony:announcements'));
    refresh();
  }
  async function update(
    entry: Announcement,
    changes: Partial<Pick<Announcement, 'status' | 'pinned'>>,
  ) {
    setBusy(entry.id);
    setError('');
    setNotice('');
    try {
      await api(`/api/admin/announcements/${entry.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...changes, revision: entry.revision }),
      });
      changed(
        changes.status
          ? changes.status === 'published'
            ? '公告已发布，用户现在可以阅读。'
            : '公告已撤回并保存为草稿。'
          : changes.pinned
            ? '公告已置顶。'
            : '已取消置顶。',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公告更新失败，请刷新后重试。');
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    if (!deletion) return;
    setBusy(deletion.id);
    setError('');
    try {
      await api(`/api/admin/announcements/${deletion.id}`, { method: 'DELETE' });
      setDeletion(null);
      changed('公告已删除。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公告删除失败，请重试。');
      setDeletion(null);
    } finally {
      setBusy('');
    }
  }
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 12));
  return (
    <section className="admin-list-section announcement-manager" aria-busy={loading}>
      <div className="admin-section-heading">
        <div>
          <h2>
            公告管理 <span className="admin-count">{data?.total ?? '—'}</span>
          </h2>
          <p>草稿、发布与置顶，让重要消息有一个清晰的位置。</p>
        </div>
        <button
          className="button button-primary"
          type="button"
          onClick={() => setEditor(null)}
          disabled={!!busy}
        >
          <Plus size={17} />
          新建公告
        </button>
      </div>
      {error && (
        <div className="admin-notice is-error" role="alert">
          <p>{error}</p>
          <button className="button button-ghost" type="button" onClick={refresh}>
            刷新列表
          </button>
        </div>
      )}
      {notice && (
        <div className="admin-notice" role="status">
          <CheckCircle2 size={16} />
          <p>{notice}</p>
        </div>
      )}
      {loading ? (
        <div className="audit-loading" role="status">
          <LoaderCircle size={19} className="spin" />
          正在读取公告…
        </div>
      ) : error && !data?.items.length ? null : !data?.items.length ? (
        <div className="admin-empty">
          <span className="admin-empty-symbol">
            <Megaphone size={28} strokeWidth={1.3} />
          </span>
          <span className="eyebrow">A NOTE FOR EVERYONE</span>
          <h3>在这里发布第一条公告</h3>
          <p>先保存草稿，准备好后再发布给用户。</p>
          <button className="button button-primary" type="button" onClick={() => setEditor(null)}>
            <Plus size={16} />
            创建公告
          </button>
        </div>
      ) : (
        <div className="admin-announcement-list">
          {data.items.map((entry) => (
            <article
              className="admin-announcement-row"
              key={entry.id}
              data-announcement-id={entry.id}
            >
              <header>
                <div className="announcement-status-line">
                  <span
                    className={`admin-status-badge${entry.status === 'published' ? ' is-published' : ''}`}
                  >
                    {entry.status === 'published' ? '已发布' : '草稿'}
                  </span>
                  {entry.pinned && (
                    <span className="announcement-pin-label">
                      <Pin size={12} />
                      置顶
                    </span>
                  )}
                  <span className="announcement-revision">v{entry.revision}</span>
                </div>
                <h3>{entry.title}</h3>
              </header>
              <p>{entry.body}</p>
              <footer>
                <time dateTime={entry.updatedAt}>
                  更新于{' '}
                  {new Date(entry.updatedAt).toLocaleString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                </time>
                <div className="admin-row-actions">
                  <button
                    className="button button-ghost"
                    type="button"
                    onClick={() =>
                      void update(entry, {
                        status: entry.status === 'published' ? 'draft' : 'published',
                      })
                    }
                    disabled={!!busy}
                  >
                    {busy === entry.id ? <LoaderCircle className="spin" size={14} /> : null}
                    {entry.status === 'published' ? '撤回' : '发布'}
                  </button>
                  <button
                    className="admin-icon-button"
                    type="button"
                    aria-label={`${entry.pinned ? '取消置顶' : '置顶'} ${entry.title}`}
                    title={entry.pinned ? '取消置顶' : '置顶公告'}
                    aria-pressed={entry.pinned}
                    onClick={() => void update(entry, { pinned: !entry.pinned })}
                    disabled={!!busy}
                  >
                    <Pin size={16} />
                  </button>
                  <button
                    className="admin-icon-button"
                    type="button"
                    aria-label={`编辑公告 ${entry.title}`}
                    title="编辑公告"
                    onClick={() => setEditor(entry)}
                    disabled={!!busy}
                  >
                    <FilePenLine size={16} />
                  </button>
                  <button
                    className="admin-icon-button is-danger"
                    type="button"
                    aria-label={`删除公告 ${entry.title}`}
                    title="删除公告"
                    onClick={() => setDeletion(entry)}
                    disabled={!!busy}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </div>
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
      {editor !== undefined && (
        <Editor
          entry={editor}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            changed('公告已保存。');
          }}
          onReload={() => {
            setEditor(undefined);
            refresh();
          }}
        />
      )}
      {deletion && (
        <Dialog title="删除这条公告？" onClose={() => setDeletion(null)} busy={!!busy}>
          <div className="admin-confirm-body">
            <p>
              删除「<strong>{deletion.title}</strong>」后，公告与对应已读记录会永久清除。
            </p>
            <p className="muted">如果只是暂时停止展示，可以在列表中撤回公告。</p>
          </div>
          <footer className="admin-dialog-footer">
            <div>
              <button
                className="button button-secondary"
                type="button"
                data-dialog-close
                disabled={!!busy}
              >
                保留公告
              </button>
              <button
                className="button admin-danger-button"
                type="button"
                onClick={() => void remove()}
                disabled={!!busy}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
                确认删除公告
              </button>
            </div>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
