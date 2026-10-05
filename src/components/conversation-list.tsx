'use client';
import { Select } from '@/components/select';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  MessageCircle,
  Plus,
  Search,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useSession } from './session-provider';
import { AuthPrompt, CharacterAvatar, Modal, Spinner } from './ui';
import { api, announceConversationChange, relativeDate } from '@/lib/client';
import type { Character, Conversation, Provider } from '@/lib/types';
import { splitBubbles } from '@/lib/message-display';

export function ConversationList({ groupsOnly = false }: { groupsOnly?: boolean }) {
  const { user, site, loading: sessionLoading } = useSession();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [scene, setScene] = useState('');
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const load = useCallback(() => {
    if (!user) return Promise.resolve();
    return Promise.all([
      api<{ conversations: Conversation[] }>('/api/conversations'),
      api<{ characters: Character[] }>('/api/characters'),
      api<{ providers: Provider[] }>('/api/providers'),
    ])
      .then(([a, b, c]) => {
        setConversations(a.conversations);
        setCharacters(b.characters);
        setProviders(c.providers);
      })
      .catch((error: Error) => setError(error.message))
      .finally(() => setLoading(false));
  }, [user]);
  useEffect(() => {
    void load();
  }, [load]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { conversation } = await api<{ conversation: Conversation }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'group',
          title,
          scene,
          characterIds: selected,
          providerId: providerId || null,
        }),
      });
      announceConversationChange();
      router.push(`/chat/${conversation.id}`);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  async function deleteConversation() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/conversations/${deleting.id}`, { method: 'DELETE' });
      setConversations((value) => value.filter((item) => item.id !== deleting.id));
      setDeleting(null);
      announceConversationChange();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const previews = conversations.map((item) => ({
    ...item,
    displayMessage:
      item.lastMessageRole === 'assistant'
        ? splitBubbles(
            item.lastMessage || '',
            site?.bubbleSeparator,
            site?.hiddenOutputMarkers,
          ).join(' · ') || '此条回复没有可显示的内容'
        : item.lastMessage,
  }));
  const filtered = previews.filter(
    (item) =>
      (!groupsOnly || item.kind === 'group') &&
      `${item.title} ${item.displayMessage || ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <span className="eyebrow">{groupsOnly ? 'BETTER TOGETHER' : 'YOUR ONGOING STORIES'}</span>
          <h1>
            {groupsOnly ? '群聊空间' : '我的对话'}
            <span className="heading-spark">✧</span>
          </h1>
          <p>{groupsOnly ? '多一位朋友，多一种故事的可能。' : '那些未完待续的故事，都在这里。'}</p>
        </div>
        {groupsOnly ? (
          <button
            className="button button-primary"
            onClick={() => (user ? setShowCreate(true) : router.push('/login'))}
          >
            <Plus size={17} />
            创建群聊
          </button>
        ) : (
          <Link href="/" className="button button-primary">
            <Plus size={17} />
            开启新对话
          </Link>
        )}
      </div>
      {error && !showCreate && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {sessionLoading || (user && loading) ? (
        <Spinner />
      ) : !user ? (
        <AuthPrompt
          description={
            groupsOnly ? '登录后，邀请多位角色进入同一个场景，让故事一起发生。' : undefined
          }
        />
      ) : (
        <>
          {groupsOnly && (
            <div className="group-intro-paper">
              <UsersRound size={40} strokeWidth={1} />
              <div>
                <span className="eyebrow">EVERYONE HAS A PART TO PLAY</span>
                <h2>同一个场景，不同的声音。</h2>
                <p>
                  选择 2–6 位角色，写下场景设定。自由发送消息，用 @
                  邀请角色回应。角色也能邀请彼此接话，自动回复设有上限。
                </p>
              </div>
              <span aria-hidden="true" className="group-intro-spark">
                ✳
              </span>
            </div>
          )}
          <div className="list-toolbar">
            <span className="muted small">
              共 {filtered.length} 段{groupsOnly ? '群聊' : '对话'}
            </span>
            <label className="search-input">
              <Search size={16} />
              <input
                placeholder="搜索对话"
                aria-label="搜索对话"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {!filtered.length ? (
            <div className="empty-state paper-empty">
              <div className="empty-symbol">
                {groupsOnly ? (
                  <UsersRound size={30} strokeWidth={1.3} />
                ) : (
                  <MessageCircle size={30} strokeWidth={1.3} />
                )}
              </div>
              <h2>
                {query
                  ? '没有匹配的对话'
                  : groupsOnly
                    ? '给大家一个相聚的理由'
                    : '下一句「你好」，由你开启'}
              </h2>
              <p>
                {query
                  ? '换个关键词，再找找看。'
                  : groupsOnly
                    ? '从一段简单的场景设定开始，邀请角色加入你的故事。'
                    : '选择一位已发布的角色，开始你的第一段对话。'}
              </p>
              {!query &&
                (groupsOnly ? (
                  <button className="button button-secondary" onClick={() => setShowCreate(true)}>
                    创建第一个群聊 <ArrowRight size={16} />
                  </button>
                ) : (
                  <Link href="/" className="button button-secondary">
                    去发现角色 <ArrowRight size={16} />
                  </Link>
                ))}
            </div>
          ) : (
            <div className="conversation-cards">
              {filtered.map((conversation) => (
                <article key={conversation.id} className="conversation-card">
                  <Link href={`/chat/${conversation.id}`} className="conversation-card-main">
                    <div className="avatar-stack">
                      {conversation.characterIds.slice(0, 3).map((id) => (
                        <CharacterAvatar
                          key={id}
                          character={characters.find((item) => item.id === id)}
                        />
                      ))}
                    </div>
                    <div className="conversation-card-text">
                      <span className="eyebrow">
                        {conversation.kind === 'group' ? 'GROUP STORY' : 'PRIVATE CONVERSATION'} ·{' '}
                        {relativeDate(conversation.updatedAt)}
                      </span>
                      <h3>{conversation.title}</h3>
                      <p>{conversation.displayMessage || conversation.scene || '继续这段故事…'}</p>
                    </div>
                    <ArrowUpRight size={20} />
                  </Link>
                  <button
                    className="icon-button delete-conversation"
                    aria-label={`删除对话 ${conversation.title}`}
                    onClick={() => setDeleting(conversation)}
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {showCreate && (
        <Modal
          title="创建群聊"
          wide
          dismissible={!busy}
          onClose={() => {
            if (!busy) {
              setShowCreate(false);
              setError('');
            }
          }}
        >
          <form onSubmit={create} className="stack-form">
            <p className="muted">
              每位角色都能看见场景内的对话。普通消息不会触发回复，@ 角色后才会邀请 TA 发言。
            </p>
            <label className="field">
              <span>群聊名称</span>
              <input
                required
                maxLength={80}
                placeholder="为这次相聚取个名字"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="field">
              <span>
                邀请角色 <small>已选 {selected.length} / 6，至少选择 2 位</small>
              </span>
              {!characters.length ? (
                <p className="notice">
                  还没有已发布的角色。
                  {user?.role === 'admin' ? (
                    <Link href="/admin?tab=characters" className="text-link">
                      先去后台创建角色。
                    </Link>
                  ) : (
                    '管理员发布角色后即可创建群聊。'
                  )}
                </p>
              ) : (
                <div className="member-picker">
                  {characters.map((character) => (
                    <button
                      key={character.id}
                      type="button"
                      className={`member-option ${selected.includes(character.id) ? 'selected' : ''}`}
                      onClick={() =>
                        setSelected((items) =>
                          items.includes(character.id)
                            ? items.filter((id) => id !== character.id)
                            : items.length < 6
                              ? [...items, character.id]
                              : items,
                        )
                      }
                      disabled={selected.length === 6 && !selected.includes(character.id)}
                    >
                      <CharacterAvatar character={character} size="small" />
                      <span>{character.name}</span>
                      {selected.includes(character.id) && <Check size={15} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <label className="field">
              <span>
                场景设定 <small>选填</small>
              </span>
              <textarea
                rows={4}
                maxLength={4000}
                placeholder="你们在哪里？正在发生什么？可以从一次轻松的午后聚会开始。"
                value={scene}
                onChange={(event) => setScene(event.target.value)}
              />
            </label>
            <label className="field">
              <span>对话模型</span>
              <Select value={providerId} onValueChange={setProviderId} aria-label="对话模型">
                <option value="">使用平台默认模型</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </Select>
            </label>
            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
            <button
              className="button button-primary full-width"
              disabled={busy || selected.length < 2}
            >
              {busy ? '正在创建…' : '开始这段群聊'}
              <ArrowRight size={17} />
            </button>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除这段对话？"
          dismissible={!busy}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <p className="muted">
            「{deleting.title}
            」及其中的全部消息会被永久删除。角色的长期记忆会保留，你可以在记忆档案中单独管理。
          </p>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setDeleting(null)}
              disabled={busy}
            >
              保留对话
            </button>
            <button
              className="button button-danger"
              onClick={() => void deleteConversation()}
              disabled={busy}
            >
              {busy ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
