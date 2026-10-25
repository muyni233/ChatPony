'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import Link from 'next/link';
import {
  BookHeart,
  Compass,
  Edit3,
  LogIn,
  MessageCircle,
  Plus,
  Search,
  Trash2,
  Users,
  ArrowUpRight,
  Info,
  RefreshCw,
} from 'lucide-react';
import { useApp } from './app-provider';
import { Avatar, Badge, Button, EmptyState, Field, Modal, Select, Skeleton } from './ui';
import { NewChat } from './new-chat';
import { api, dateLabel, json } from '@/lib/client';
import { visibleMessage } from '@/lib/display';
import type { Character, Conversation, Memory } from '@/lib/types';

export function PageHeading({
  title,
  description,
  action,
}: {
  /** Retained for call-site compatibility; the platform header no longer shows eyebrows. */
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div className="page-heading-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="page-heading-actions">{action}</div>}
    </div>
  );
}
export function AuthRequired({
  title = '请先登录',
  description = '登录后可查看对话和记忆。',
}: {
  title?: string;
  description?: string;
}) {
  const { openAuth } = useApp();
  return (
    <div className="paper-card">
      <EmptyState
        icon={<LogIn size={26} />}
        title={title}
        description={description}
        action={
          <Button onClick={() => openAuth()}>
            登录 / 注册
            <ArrowUpRight size={15} />
          </Button>
        }
      />
    </div>
  );
}
export function Loading({ variant = 'grid' }: { variant?: 'grid' | 'list' }) {
  return (
    <div className={`loading-screen loading-${variant}`} role="status" aria-live="polite">
      <span className="visually-hidden">加载中…</span>
      {variant === 'grid'
        ? [0, 1, 2, 3, 4, 5].map((i) => (
            <div className="card loading-card" key={i} aria-hidden="true">
              <div className="loading-card-top">
                <Skeleton width={48} height={48} radius={14} />
                <Skeleton width={64} height={20} radius={999} />
              </div>
              <Skeleton width="45%" height={14} />
              <Skeleton width="90%" height={10} />
              <Skeleton width="70%" height={10} />
            </div>
          ))
        : [0, 1, 2, 3].map((i) => (
            <div className="card loading-row" key={i} aria-hidden="true">
              <Skeleton width={40} height={40} radius={12} />
              <span>
                <Skeleton width="30%" height={13} />
                <Skeleton width="65%" height={10} />
              </span>
            </div>
          ))}
    </div>
  );
}

export function CharactersPage() {
  const { data, loading, openAuth } = useApp();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Character | null>(null);
  const publicCharacters = (data?.characters || []).filter((character) => !character.ownerId);
  const characters = publicCharacters.filter((c) =>
    `${c.name} ${c.description} ${c.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
  );
  function start(c: Character) {
    if (!data?.user) openAuth();
    else setSelected(c);
  }
  return (
    <div className="page-enter">
      <PageHeading title="角色广场" />
      <div className="toolbar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索角色"
            placeholder="搜索名称、简介或标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Badge tone="green">{publicCharacters.length} 个角色</Badge>
      </div>
      {loading ? (
        <Loading />
      ) : characters.length ? (
        <div className="content-grid">
          {characters.map((c) => (
            <article
              className="paper-card character-card"
              key={c.id}
              style={{ '--character-color': c.color } as CSSProperties}
            >
              <div className="character-card-top">
                <Avatar name={c.name} src={c.avatar} color={c.color} size="large" />
              </div>
              <h3>{c.name}</h3>
              <span className="character-handle">@{c.slug}</span>
              <p>{c.description || '暂无简介'}</p>
              <div className="character-tags">
                {c.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
              <Button variant="secondary" onClick={() => start(c)}>
                <MessageCircle size={16} />
                开始对话
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <div className="paper-card">
          <EmptyState
            icon={<Compass size={28} />}
            title={query ? '没有找到匹配的角色' : '暂无角色'}
            description={query ? '试试其他名称或标签。' : '管理员发布角色后会显示在这里。'}
            action={
              query ? (
                <Button variant="secondary" onClick={() => setQuery('')}>
                  清除搜索
                </Button>
              ) : data?.user?.role === 'admin' ? (
                <Link className="button button-primary" href="/admin">
                  <Plus size={16} />
                  添加角色
                </Link>
              ) : undefined
            }
          />
        </div>
      )}
      {selected && (
        <NewChat open initialCharacter={selected.id} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

export function ConversationsPage() {
  const { data, loading, refresh, notify, openAuth } = useApp();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'private' | 'group'>('all');
  const [newChat, setNewChat] = useState(false);
  const [remove, setRemove] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const conversations = (data?.conversations || []).filter(
    (c) =>
      (filter === 'all' || c.kind === filter) &&
      `${c.title} ${c.lastMessage}`.toLowerCase().includes(query.toLowerCase()),
  );
  function create() {
    if (!data?.user) openAuth();
    else setNewChat(true);
  }
  async function deleteConversation() {
    if (!remove) return;
    setBusy(true);
    try {
      await api(`/conversations/${remove.id}`, json('DELETE'));
      await refresh();
      setRemove(null);
      notify('对话已删除。');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-enter">
      <PageHeading
        title="我的对话"
        action={
          <Button onClick={create}>
            <Plus size={16} />
            新建对话
          </Button>
        }
      />
      {loading ? (
        <Loading variant="list" />
      ) : !data?.user ? (
        <AuthRequired />
      ) : (
        <>
          <div className="toolbar">
            <div className="filter-tabs">
              {(['all', 'private', 'group'] as const).map((f) => (
                <button
                  key={f}
                  aria-pressed={filter === f}
                  className={filter === f ? 'selected' : ''}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? '全部' : f === 'private' ? '私聊' : '群聊'}
                  <span>
                    {data.conversations.filter((c) => f === 'all' || c.kind === f).length}
                  </span>
                </button>
              ))}
            </div>
            <div className="search-box">
              <Search size={17} />
              <input
                placeholder="搜索对话"
                aria-label="搜索对话"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {conversations.length ? (
            <div className="conversation-list">
              {conversations.map((c) => {
                const ch = data.characters.find((ch) => ch.id === c.characterIds[0]);
                return (
                  <article className="paper-card conversation-row" key={c.id}>
                    <Link href={`/chat/${c.id}`}>
                      <Avatar
                        name={c.kind === 'group' ? '群' : ch?.name || c.title}
                        src={c.kind === 'private' ? ch?.avatar : undefined}
                        color={ch?.color}
                      />
                      <div className="conversation-row-info">
                        <h3>
                          {c.title}
                          <Badge tone={c.kind === 'group' ? 'pink' : 'green'}>
                            {c.kind === 'group' ? (
                              <>
                                <Users size={10} />
                                群聊
                              </>
                            ) : (
                              '私聊'
                            )}
                          </Badge>
                        </h3>
                        <p>{visibleMessage(c.lastMessage, data.settings) || '暂无消息'}</p>
                      </div>
                      <time>{dateLabel(c.updatedAt)}</time>
                    </Link>
                    <button
                      className="icon-button"
                      aria-label={`删除对话 ${c.title}`}
                      onClick={() => setRemove(c)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="paper-card">
              <EmptyState
                icon={<MessageCircle size={27} />}
                title={query ? '没有找到匹配的对话' : '暂无对话'}
                description={query ? '试试其他关键词，或更换对话分类。' : '新建一个私聊或群聊。'}
                action={
                  <Button variant="secondary" onClick={create}>
                    <Plus size={16} />
                    新建对话
                  </Button>
                }
              />
            </div>
          )}
        </>
      )}
      {newChat && <NewChat open onClose={() => setNewChat(false)} />}
      <Modal
        open={!!remove}
        onClose={() => !busy && setRemove(null)}
        title="删除对话？"
        description={`「${remove?.title || ''}」的消息和摘要将被永久删除，角色记忆会保留。此操作无法撤销。`}
      >
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={() => setRemove(null)}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={deleteConversation}>
            删除对话
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function MemoriesPage() {
  const { data, loading, refresh, notify } = useApp();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [remove, setRemove] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [formError, setFormError] = useState('');
  const userId = data?.user?.id;
  const load = useCallback(async () => {
    if (!userId) {
      setMemories([]);
      return;
    }
    setPending(true);
    try {
      setMemories(await api<Memory[]>('/memories'));
      setFailure('');
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setPending(false);
    }
  }, [userId]);
  useEffect(() => {
    void load();
  }, [load]);
  const characters = data?.characters || [];
  const rememberedCharacters = [
    ...new Map([
      ...memories.map(
        (memory) =>
          [
            memory.characterId,
            { id: memory.characterId, name: memory.characterName || '历史角色' },
          ] as const,
      ),
      ...characters.map(
        (character) => [character.id, { id: character.id, name: character.name }] as const,
      ),
    ]).values(),
  ];
  const filtered = memories.filter((m) => !filter || m.characterId === filter);
  function edit(memory: Memory | 'new') {
    setFormError('');
    setEditing(memory);
  }
  async function rebuild() {
    setIndexing(true);
    try {
      const result = await api<{ indexed: number; failed: number; pending: number }>(
        '/memories/reindex',
        json('POST'),
      );
      await load();
      notify(
        `本批已索引 ${result.indexed} 条，失败 ${result.failed} 条，剩余待索引 ${result.pending} 条。${result.pending ? '可再次点击继续。' : ''}`,
        result.failed ? 'error' : 'success',
      );
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setIndexing(false);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setFormError('');
    try {
      await api(
        editing === 'new' ? '/memories' : `/memories/${editing.id}`,
        json(
          editing === 'new' ? 'POST' : 'PATCH',
          editing === 'new' ? fields : { content: fields.content },
        ),
      );
      await load();
      await refresh();
      setEditing(null);
      notify('记忆已保存，建立向量索引后将用于相关对话。');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteMemory() {
    if (!remove) return;
    setBusy(true);
    try {
      await api(`/memories/${remove.id}`, json('DELETE'));
      await load();
      await refresh();
      setRemove(null);
      notify('这条记忆已删除。');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-enter">
      <PageHeading
        title="记忆"
        description="角色回复时会检索与当前消息相关的记忆。"
        action={
          data?.user && (
            <Button disabled={!characters.length} onClick={() => edit('new')}>
              <Plus size={16} />
              添加记忆
            </Button>
          )
        }
      />
      {loading ? (
        <Loading />
      ) : !data?.user ? (
        <AuthRequired title="请先登录" />
      ) : (
        <>
          <div className="page-intro-note">
            <Info size={17} />
            <span>记忆按角色分别保存，仅自己可见。管理员启用 Embedding 服务后才会建立索引。</span>
          </div>
          <div className="toolbar">
            <div className="filter-tabs">
              <Button
                variant="secondary"
                loading={indexing}
                disabled={!memories.length || pending}
                onClick={rebuild}
              >
                <RefreshCw size={14} />
                重建索引
              </Button>
              <button
                aria-pressed={!filter}
                className={!filter ? 'selected' : ''}
                onClick={() => setFilter('')}
              >
                全部记忆<span>{memories.length}</span>
              </button>
            </div>
            <Select
              value={filter}
              onValueChange={setFilter}
              aria-label="按角色筛选记忆"
              style={{ width: 210, fontSize: 12 }}
            >
              <option value="">所有角色</option>
              {rememberedCharacters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          {failure ? (
            <div className="form-error" role="alert">
              {failure}{' '}
              <button className="text-button" onClick={load}>
                重试
              </button>
            </div>
          ) : pending ? (
            <Loading />
          ) : filtered.length ? (
            <div className="content-grid">
              {filtered.map((m) => {
                const c = characters.find((c) => c.id === m.characterId);
                return (
                  <article className="paper-card memory-card" key={m.id}>
                    <div className="memory-top">
                      <Avatar
                        name={c?.name || m.characterName || '角'}
                        src={c?.avatar ?? m.characterAvatar}
                        size="small"
                        color={c?.color ?? m.characterColor}
                      />
                      <strong>{c?.name || m.characterName || '历史角色'}</strong>
                      <Badge tone={m.source === 'auto' ? 'green' : 'amber'}>
                        {m.source === 'auto' ? '对话记忆' : '手动添加'}
                      </Badge>
                    </div>
                    <p>{visibleMessage(m.content, data.settings)}</p>
                    <Badge
                      tone={
                        m.vectorStatus === 'ready'
                          ? 'green'
                          : m.vectorStatus === 'failed'
                            ? 'pink'
                            : 'amber'
                      }
                    >
                      {m.vectorStatus === 'ready'
                        ? '已建立向量索引'
                        : m.vectorStatus === 'failed'
                          ? '索引失败 · 可重试'
                          : m.vectorStatus === 'disabled'
                            ? '等待启用 Embedding'
                            : '等待建立索引'}
                    </Badge>
                    <div className="memory-bottom">
                      <time>{dateLabel(m.updatedAt)}</time>
                      <span className="memory-actions">
                        <button
                          className="icon-button"
                          aria-label="编辑记忆"
                          onClick={() => edit(m)}
                        >
                          <Edit3 size={14} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="删除记忆"
                          onClick={() => setRemove(m)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="paper-card">
              <EmptyState
                icon={<BookHeart size={27} />}
                title="暂无记忆"
                description="添加希望角色记住的信息，例如称呼或喜好。"
                action={
                  <Button
                    variant="secondary"
                    disabled={!characters.length}
                    onClick={() => edit('new')}
                  >
                    <Plus size={15} />
                    添加记忆
                  </Button>
                }
              />
            </div>
          )}
        </>
      )}
      <Modal
        open={!!editing}
        onClose={() => !busy && setEditing(null)}
        title={editing === 'new' ? '添加记忆' : '编辑记忆'}
        description="保存后建立索引，该角色回复时会检索相关记忆。"
      >
        {editing && (
          <form
            className="form-stack"
            onSubmit={save}
            key={typeof editing === 'string' ? editing : editing.id}
          >
            {editing === 'new' && (
              <Field label="关联角色">
                <Select
                  name="characterId"
                  required
                  defaultValue={
                    characters.some((character) => character.id === filter)
                      ? filter
                      : characters[0]?.id
                  }
                >
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="记忆内容" hint="只记录你希望角色记住的信息，最多 2,000 字。">
              <textarea
                name="content"
                rows={5}
                maxLength={2000}
                required
                defaultValue={editing === 'new' ? '' : editing.content}
                placeholder="例如：我叫小星，喜欢读书。"
              />
            </Field>
            {formError && (
              <p className="form-error" role="alert">
                {formError}
              </p>
            )}
            <div className="modal-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </Button>
              <Button type="submit" loading={busy}>
                保存记忆
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={!!remove}
        onClose={() => !busy && setRemove(null)}
        title="删除这条记忆？"
        description="删除后，对应的向量索引也会移除，角色将不再通过语义检索获取这条内容。已有对话不受影响。"
      >
        <div className="modal-actions">
          <Button variant="secondary" disabled={busy} onClick={() => setRemove(null)}>
            取消
          </Button>
          <Button variant="danger" loading={busy} onClick={deleteMemory}>
            删除记忆
          </Button>
        </div>
      </Modal>
    </div>
  );
}
