'use client';
import { Select } from '@/components/select';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Bookmark, Check, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { api, relativeDate } from '@/lib/client';
import { useSession } from './session-provider';
import { AuthPrompt, CharacterAvatar, Modal, Spinner } from './ui';
import type { Character, Memory } from '@/lib/types';

export function Memories() {
  const { user, loading: sessionLoading } = useSession();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [editor, setEditor] = useState<Memory | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [characterId, setCharacterId] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!user) return Promise.resolve();
    return Promise.all([
      api<{ memories: Memory[] }>('/api/memories'),
      api<{ characters: Character[] }>('/api/characters'),
    ])
      .then(([a, b]) => {
        setMemories(a.memories);
        setCharacters(b.characters);
      })
      .catch((error: Error) => setError(error.message))
      .finally(() => setLoading(false));
  }, [user]);
  useEffect(() => {
    void load();
  }, [load]);
  function edit(memory: Memory | 'new') {
    setEditor(memory);
    setCharacterId(memory === 'new' ? filter || characters[0]?.id || '' : memory.characterId);
    setContent(memory === 'new' ? '' : memory.content);
    setError('');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(editor === 'new' ? '/api/memories' : `/api/memories/${(editor as Memory).id}`, {
        method: editor === 'new' ? 'POST' : 'PATCH',
        body: JSON.stringify({ characterId, content: content.trim() }),
      });
      setEditor(null);
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/memories/${deleting.id}`, { method: 'DELETE' });
      setMemories((items) => items.filter((item) => item.id !== deleting.id));
      setDeleting(null);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = memories.filter(
    (memory) =>
      (!filter || memory.characterId === filter) &&
      memory.content.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">THINGS WORTH REMEMBERING</span>
          <h1>
            记忆档案 <span className="heading-spark">✧</span>
          </h1>
          <p>重要的偏好、小小的约定，让下一次对话更熟悉。</p>
        </div>
        {user && (
          <button className="button button-primary" onClick={() => edit('new')}>
            <Plus size={17} />
            添加记忆
          </button>
        )}
      </div>
      {error && !editor && !deleting && (
        <div role="alert" className="error-message">
          {error}
        </div>
      )}
      {sessionLoading || (user && loading) ? (
        <Spinner />
      ) : !user ? (
        <AuthPrompt description="登录后，管理只属于你和角色之间的长期记忆。" />
      ) : (
        <>
          <div className="memory-explainer">
            <Bookmark size={22} strokeWidth={1.4} />
            <p>
              <strong>由你决定，哪些事情值得记住。</strong>
              记忆按角色保存，用于之后的私聊与群聊；你可以随时编辑或删除。长对话的上下文摘要会自动维护，与这里的长期记忆分开保存。
            </p>
          </div>
          <div className="list-toolbar">
            <label className="inline-select">
              <span className="small muted">查看</span>
              <Select
                aria-label="筛选记忆角色"
                value={filter}
                onValueChange={setFilter}
                variant="compact"
              >
                <option value="">所有角色 · {memories.length}</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="search-input">
              <Search size={16} />
              <input
                placeholder="搜索记忆"
                aria-label="搜索记忆"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {!filtered.length ? (
            <div className="empty-state paper-empty">
              <div className="empty-symbol">
                <Bookmark size={30} strokeWidth={1.3} />
              </div>
              <h2>{query || filter ? '这里还没有匹配的记忆' : '从一件小事开始记住你'}</h2>
              <p>
                {characters.length
                  ? '例如你喜欢的称呼、你们的共同经历，或下次还想继续的话题。'
                  : '角色发布后，你就能为每位角色添加专属记忆。'}
              </p>
              {characters.length ? (
                <button className="button button-secondary" onClick={() => edit('new')}>
                  添加第一条记忆 <Plus size={16} />
                </button>
              ) : (
                <Link href="/" className="button button-secondary">
                  回到发现 <ArrowUpRight size={16} />
                </Link>
              )}
            </div>
          ) : (
            <div className="memory-grid">
              {filtered.map((memory, index) => {
                const character = characters.find((item) => item.id === memory.characterId);
                return (
                  <article className="memory-note" key={memory.id}>
                    <div className="memory-note-top">
                      <span className="eyebrow">MEMORY {String(index + 1).padStart(2, '0')}</span>
                      <span className="small muted">{relativeDate(memory.updatedAt)}</span>
                    </div>
                    <p>{memory.content}</p>
                    <div className="memory-note-bottom">
                      <div className="memory-character">
                        <CharacterAvatar character={character} size="small" />
                        <span>{character?.name || '已下架角色'}</span>
                      </div>
                      <div className="inline-actions">
                        <button
                          className="icon-button"
                          aria-label="编辑记忆"
                          onClick={() => edit(memory)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label="删除记忆"
                          onClick={() => setDeleting(memory)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
      {editor && (
        <Modal
          title={editor === 'new' ? '添加一条记忆' : '编辑这条记忆'}
          dismissible={!busy}
          onClose={() => {
            if (!busy) setEditor(null);
          }}
        >
          <form onSubmit={save} className="stack-form">
            <label className="field">
              <span>谁会记得这件事？</span>
              <Select
                required
                disabled={editor !== 'new'}
                value={characterId}
                onValueChange={setCharacterId}
                aria-label="记忆角色"
              >
                <option value="" disabled>
                  选择一位角色
                </option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
                {editor !== 'new' &&
                  !characters.some((character) => character.id === characterId) && (
                    <option value={characterId}>已下架角色</option>
                  )}
              </Select>
            </label>
            <label className="field">
              <span>
                记忆内容 <small>{content.length} / 2000</small>
              </span>
              <textarea
                rows={5}
                required
                minLength={1}
                maxLength={2000}
                placeholder="写下一件希望 TA 在以后的对话中记住的事…"
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <p className="small muted">这条记忆仅用于你的账号与所选角色的对话。</p>
            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
            <button
              className="button button-primary full-width"
              disabled={busy || !characterId || !content.trim()}
            >
              {busy ? '正在保存…' : '保存记忆'}
              <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除这条记忆？"
          dismissible={!busy}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <p className="muted">
            删除后，这条记忆将不再主动用于之后的对话。它在已有聊天记录或摘要中的内容不会自动移除。
          </p>
          {error && (
            <div role="alert" className="error-message">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </button>
            <button className="button button-danger" disabled={busy} onClick={() => void remove()}>
              {busy ? '正在删除…' : '删除记忆'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
