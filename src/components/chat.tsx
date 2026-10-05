'use client';
import { Select } from '@/components/select';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowUp,
  Bookmark,
  Check,
  ChevronDown,
  Download,
  Info,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  UsersRound,
  X,
} from 'lucide-react';
import { api, announceConversationChange, streamChat } from '@/lib/client';
import { useSession } from './session-provider';
import { AuthPrompt, CharacterAvatar, Modal, Spinner } from './ui';
import type { Character, ConversationDetail, Memory, Message, Provider } from '@/lib/types';
import { splitBubbles } from '@/lib/message-display';
import { QuotaInline, quotaUnavailable, useQuota } from './quota';

type PendingTurn = { content: string; characterId?: string; requestId: string };
type Draft = { id: string; characterId: string; content: string };
export function Chat({ id }: { id: string }) {
  const { user, site, loading: sessionLoading } = useSession();
  const userId = user?.id;
  const quotaState = useQuota();
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [speaker, setSpeaker] = useState('');
  const [retry, setRetry] = useState<PendingTurn | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editScene, setEditScene] = useState('');
  const [editProvider, setEditProvider] = useState('');
  const [saving, setSaving] = useState(false);
  const [memoryTarget, setMemoryTarget] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryOpen, setMemoryOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentionRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const [mentionOpen, setMentionOpen] = useState(false);
  useEffect(() => {
    if (!mentionOpen) return;
    const close = (event: PointerEvent) => {
      if (
        !(event.target as Element).closest('.mention-control') &&
        event.target !== inputRef.current
      )
        setMentionOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [mentionOpen]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);
  const loadConversation = useCallback(async () => {
    const data = await api<ConversationDetail>(`/api/conversations/${id}`);
    if (mountedRef.current) {
      setDetail(data);
      setMessages(data.messages);
    }
    return data;
  }, [id]);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    Promise.all([
      api<ConversationDetail>(`/api/conversations/${id}`),
      api<{ providers: Provider[] }>('/api/providers'),
      api<{ memories: Memory[] }>('/api/memories'),
    ])
      .then(([a, b, c]) => {
        if (active) {
          setDetail(a);
          setMessages(a.messages);
          setProviders(b.providers);
          setMemories(c.memories);
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abortRef.current?.abort();
    };
  }, [id, userId]);
  useEffect(() => {
    if (followRef.current) bottomRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [messages, draft, status]);
  useEffect(() => {
    const list = messagesRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current)
        bottomRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [detail?.conversation.id]);
  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    }
  }, [text]);
  const currentCharacters = detail?.characters || [];
  const group = detail?.conversation.kind === 'group';
  const activeMemories = memories.filter((memory) =>
    currentCharacters.some((character) => character.id === memory.characterId),
  );
  function mention(character: Character) {
    setText((value) =>
      value.endsWith('@')
        ? `${value}${character.name} `
        : `${value}${value && !value.endsWith(' ') ? ' ' : ''}@${character.name} `,
    );
    setSpeaker(character.id);
    setMentionOpen(false);
    inputRef.current?.focus();
  }
  async function send(turn?: PendingTurn) {
    if (sending || (!turn && !text.trim())) return;
    if ((!group || turn?.characterId) && quotaUnavailable(quotaState.quota)) return;
    const pending = turn || { content: text.trim(), requestId: crypto.randomUUID() };
    setSending(true);
    setError('');
    setNotice('');
    setRetry(null);
    setDraft(null);
    setStatus(
      group && !pending.characterId && !pending.content.includes('@')
        ? '正在保存消息…'
        : '正在等待回应…',
    );
    if (!turn) setText('');
    followRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    let failed = false;
    let quotaRefreshed = false;
    try {
      await streamChat(
        `/api/conversations/${id}/messages`,
        pending,
        (event) => {
          if (!mountedRef.current) return;
          if (event.type === 'start' && !quotaRefreshed) {
            quotaRefreshed = true;
            window.dispatchEvent(new Event('chatpony:quota'));
          }
          if (event.type === 'user')
            setMessages((items) =>
              items.some((item) => item.id === event.message.id)
                ? items
                : [...items, event.message],
            );
          if (event.type === 'start') {
            setDraft({ id: event.messageId, characterId: event.characterId, content: '' });
            setStatus(
              `${currentCharacters.find((item) => item.id === event.characterId)?.name || '角色'}正在回应…`,
            );
          }
          if (event.type === 'delta')
            setDraft((value) => ({
              id: event.messageId,
              characterId: event.characterId,
              content: (value?.id === event.messageId ? value.content : '') + event.text,
            }));
          if (event.type === 'message') {
            setMessages((items) =>
              items.some((item) => item.id === event.message.id)
                ? items.map((item) => (item.id === event.message.id ? event.message : item))
                : [...items, event.message],
            );
            setDraft(null);
          }
          if (event.type === 'status') {
            setStatus(event.message);
            if (/上限|接话已|不再自动/.test(event.message)) setNotice(event.message);
          }
          if (event.type === 'error') {
            failed = true;
            setError(event.message);
            setRetry(pending);
          }
          if (event.type === 'done') setStatus('');
        },
        controller.signal,
      );
    } catch (error) {
      failed = true;
      if (controller.signal.aborted) setStatus('已停止回复');
      else setError((error as Error).message);
      setRetry(pending);
    } finally {
      if (mountedRef.current) {
        setDraft(null);
        setSending(false);
        if (!controller.signal.aborted) setStatus('');
        if (!failed) setRetry(null);
        await loadConversation().catch(() => {});
        announceConversationChange();
        abortRef.current = null;
        window.dispatchEvent(new Event('chatpony:quota'));
        inputRef.current?.focus();
      }
    }
  }
  function openEdit() {
    if (!detail) return;
    setEditTitle(detail.conversation.title);
    setEditScene(detail.conversation.scene);
    setEditProvider(detail.conversation.providerId || '');
    setEdit(true);
  }
  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api(`/api/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: editTitle,
          scene: editScene,
          providerId: editProvider || null,
        }),
      });
      await loadConversation();
      setEdit(false);
      announceConversationChange();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function addMemory(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { memory } = await api<{ memory: Memory }>('/api/memories', {
        method: 'POST',
        body: JSON.stringify({ characterId: memoryTarget, content: memoryContent.trim() }),
      });
      setMemories((items) => [memory, ...items]);
      setMemoryOpen(false);
      setMemoryContent('');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function exportConversation() {
    if (!detail) return;
    const data = {
      title: detail.conversation.title,
      scene: detail.conversation.scene,
      exportedAt: new Date().toISOString(),
      messages: messages.map((message) => {
        const bubbles =
          message.role === 'assistant'
            ? splitBubbles(message.content, site?.bubbleSeparator, site?.hiddenOutputMarkers)
            : [message.content];
        return {
          speaker:
            message.role === 'user'
              ? user?.username
              : currentCharacters.find((character) => character.id === message.characterId)?.name ||
                '角色',
          content: bubbles.join('\n\n'),
          bubbles,
          createdAt: message.createdAt,
        };
      }),
    };
    const link = document.createElement('a');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    link.href = url;
    link.download = `ChatPony-${detail.conversation.title.replace(/[<>:"/\\|?*]/g, '-').slice(0, 50)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (sessionLoading || (user && loading)) return <Spinner label="正在打开这段故事…" />;
  if (!user) return <AuthPrompt />;
  if (!detail)
    return (
      <div className="empty-state">
        <h2>暂时无法打开对话</h2>
        <p role="alert">{error || '对话不存在，或你没有访问权限。'}</p>
        <Link href="/conversations" className="button button-secondary">
          返回我的对话
        </Link>
      </div>
    );
  return (
    <div className="chat-layout page-enter">
      <section className="chat-main">
        <header className="chat-header">
          <Link
            className="icon-button"
            href={group ? '/groups' : '/conversations'}
            aria-label="返回对话列表"
          >
            <ArrowLeft size={20} />
          </Link>
          <div className="avatar-stack">
            {currentCharacters.slice(0, 3).map((character) => (
              <CharacterAvatar key={character.id} character={character} size="small" />
            ))}
          </div>
          <div className="chat-title">
            <h1>{detail.conversation.title}</h1>
            <span>
              {group
                ? `${currentCharacters.length} 位角色 · 群聊场景`
                : `${currentCharacters[0]?.subtitle || '单角色私聊'}`}
            </span>
          </div>
          <button
            className="icon-button"
            onClick={openEdit}
            disabled={sending}
            aria-label="对话设置"
          >
            <Settings2 size={18} />
          </button>
          <button
            className="icon-button info-toggle"
            onClick={() => setShowInfo((value) => !value)}
            aria-label="查看对话详情"
          >
            <Info size={18} />
          </button>
        </header>
        <div
          className="message-list"
          ref={messagesRef}
          onScroll={() => {
            const el = messagesRef.current;
            if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 130;
          }}
        >
          <div className="conversation-beginning">
            <span />
            <span>
              {new Date(detail.conversation.createdAt).toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
              })}{' '}
              · 故事从这里开始
            </span>
            <span />
          </div>
          {detail.conversation.scene && (
            <div className="scene-inline">
              <span className="eyebrow">THE SCENE</span>
              <p>{detail.conversation.scene}</p>
            </div>
          )}
          {!messages.length && !draft && (
            <div className="chat-empty">
              <Sparkles size={30} strokeWidth={1.1} />
              <h2>一句问候，无限可能。</h2>
              <p>
                向{group ? '大家' : currentCharacters[0]?.name || '你的对话伙伴'}
                打个招呼，开始属于你们的故事。
              </p>
              <div className="starter-prompts">
                {['你好，很高兴认识你！', '今天过得怎么样？', '我们一起去散步吧。'].map(
                  (prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setText(prompt);
                        inputRef.current?.focus();
                      }}
                    >
                      {prompt}
                      <ArrowUp size={13} />
                    </button>
                  ),
                )}
              </div>
            </div>
          )}
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              character={currentCharacters.find(
                (character) => character.id === message.characterId,
              )}
              username={user.username}
              onRemember={
                message.role === 'assistant' && message.characterId
                  ? (visible) => {
                      setMemoryTarget(message.characterId!);
                      setMemoryContent(visible.slice(0, 2000));
                      setMemoryOpen(true);
                    }
                  : undefined
              }
            />
          ))}
          {draft && (
            <ChatMessage
              message={{
                ...draft,
                conversationId: id,
                role: 'assistant',
                createdAt: new Date().toISOString(),
              }}
              character={currentCharacters.find((character) => character.id === draft.characterId)}
              username={user.username}
              streaming
            />
          )}
          {status && (
            <div className="chat-status" role="status">
              {sending ? (
                <span className="typing-dots">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <Check size={14} />
              )}
              {status}
            </div>
          )}
          {notice && !sending && (
            <div className="chat-turn-notice" role="status">
              <Info size={14} />
              <span>{notice}</span>
            </div>
          )}
          {error && !edit && !memoryOpen && (
            <div className="chat-error" role="alert">
              <p>{error}</p>
              {retry && (
                <button className="text-link" disabled={sending} onClick={() => void send(retry)}>
                  <RotateCcw size={14} />
                  重试这次回复
                </button>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="composer-area">
          {group && (
            <div className="speaker-selector">
              <span>自由发言，@ 后邀请回应</span>
              <div className="mention-control">
                <button
                  type="button"
                  className="mention-button"
                  disabled={sending}
                  onClick={() => setMentionOpen((value) => !value)}
                  aria-expanded={mentionOpen}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && mentionOpen) {
                      event.preventDefault();
                      mentionRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
                    }
                  }}
                  aria-label="提及角色"
                >
                  @ 选择角色 <ChevronDown size={12} />
                </button>
                {mentionOpen && (
                  <div
                    ref={mentionRef}
                    className="mention-menu"
                    role="menu"
                    aria-label="选择要提及的角色"
                    onKeyDown={(event) => {
                      const items = Array.from(
                        mentionRef.current?.querySelectorAll<HTMLButtonElement>('button') || [],
                      );
                      const index = items.indexOf(document.activeElement as HTMLButtonElement);
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        items[
                          (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                            items.length
                        ]?.focus();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setMentionOpen(false);
                        inputRef.current?.focus();
                      }
                    }}
                  >
                    {currentCharacters.map((character) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={character.id}
                        onClick={() => mention(character)}
                      >
                        <CharacterAvatar character={character} size="small" />
                        <span>{character.name}</span>
                        <span>@</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {speaker && (
                <button
                  className="continue-button"
                  disabled={sending || !messages.length || quotaUnavailable(quotaState.quota)}
                  onClick={() =>
                    void send({ content: '', characterId: speaker, requestId: crypto.randomUUID() })
                  }
                >
                  邀请继续发言 <ArrowUp size={12} />
                </button>
              )}
            </div>
          )}
          <QuotaInline {...quotaState} group={group} />
          <form
            className={`message-composer ${sending ? 'is-sending' : ''}`}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={inputRef}
              aria-label="输入消息"
              placeholder={
                group
                  ? '随意聊聊，输入 @ 邀请角色回应…'
                  : `对${currentCharacters[0]?.name || 'TA'}说点什么…`
              }
              value={text}
              rows={2}
              maxLength={8000}
              onChange={(event) => {
                setText(event.target.value);
                if (group) setMentionOpen(event.target.value.endsWith('@'));
              }}
              onKeyDown={(event) => {
                if (mentionOpen && event.key === 'ArrowDown') {
                  event.preventDefault();
                  mentionRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  setMentionOpen(false);
                  void send();
                }
                if (event.key === 'Escape') setMentionOpen(false);
              }}
            />
            <div className="composer-bottom">
              <span className="composer-hint">
                <Sparkles size={14} />
                <span>把想象力，交给这一刻</span>
              </span>
              <span className="composer-count">
                {text.length > 6000 ? `${text.length} / 8000` : 'Shift + Enter 换行'}
              </span>
              {sending ? (
                <button
                  type="button"
                  className="send-button stop-button"
                  aria-label="停止生成"
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="发送消息"
                  disabled={!text.trim() || (!group && quotaUnavailable(quotaState.quota))}
                >
                  <ArrowUp size={19} />
                </button>
              )}
            </div>
          </form>
          <div className="composer-footer">
            <span>AI 生成的故事与现实无关，请保留自己的判断。</span>
            <span>
              {providers.find((provider) => provider.id === detail.conversation.providerId)?.name ||
                providers.find((provider) => provider.isDefault)?.name ||
                '平台默认模型'}
            </span>
          </div>
        </div>
      </section>
      <aside className={`chat-info ${showInfo ? 'show' : ''}`}>
        <div className="chat-info-heading">
          <span className="eyebrow">ABOUT THIS STORY</span>
          <button
            className="icon-button info-close"
            aria-label="关闭对话详情"
            onClick={() => setShowInfo(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="chat-info-title">
          <span className="small-stamp">
            {group ? (
              <UsersRound size={25} strokeWidth={1.3} />
            ) : (
              <MessageCircle size={25} strokeWidth={1.3} />
            )}
          </span>
          <h2>{group ? '这一次，我们在一起' : '两个人，一段故事'}</h2>
          <span className="small muted">
            {group ? '用 @ 传递话题，让故事接着走。' : '每一次对话，都更靠近一点。'}
          </span>
        </div>
        <div className="info-section">
          <h3>
            {group ? '参与角色' : '对话伙伴'}
            <span>{currentCharacters.length}</span>
          </h3>
          {currentCharacters.map((character) => (
            <div className="info-character" key={character.id}>
              <CharacterAvatar character={character} />
              <div>
                <strong>{character.name}</strong>
                <p>{character.subtitle}</p>
              </div>
            </div>
          ))}
        </div>
        {detail.conversation.scene && (
          <div className="info-section">
            <h3>
              场景设定
              <button
                className="icon-button"
                disabled={sending}
                aria-label="编辑场景"
                onClick={openEdit}
              >
                <Pencil size={13} />
              </button>
            </h3>
            <p className="info-scene">{detail.conversation.scene}</p>
          </div>
        )}
        <div className="info-section">
          <h3>
            共同的记忆{' '}
            <button
              className="icon-button"
              aria-label="添加记忆"
              onClick={() => {
                setMemoryTarget(currentCharacters[0]?.id || '');
                setMemoryContent('');
                setMemoryOpen(true);
              }}
            >
              <Plus size={15} />
            </button>
          </h3>
          {activeMemories.length ? (
            <div className="info-memories">
              {activeMemories.slice(0, 3).map((memory) => (
                <p key={memory.id}>
                  <Bookmark size={12} />
                  {memory.content}
                </p>
              ))}
              <Link href="/memories">
                管理全部 {activeMemories.length} 条记忆 <ArrowUp size={12} />
              </Link>
            </div>
          ) : (
            <p className="info-empty">
              那些想一直记得的小事，
              <br />
              可以在这里留一份。
            </p>
          )}
        </div>
        <div className="chat-info-bottom">
          <button onClick={exportConversation} className="button button-secondary full-width">
            <Download size={15} />
            导出对话
          </button>
          <span className="info-bottom-spark" aria-hidden="true">
            ✧
          </span>
          <p>
            Every conversation
            <br />
            is a little adventure.
          </p>
        </div>
      </aside>
      {edit && (
        <Modal
          title="对话设置"
          dismissible={!saving}
          onClose={() => {
            if (!saving) setEdit(false);
          }}
        >
          <form className="stack-form" onSubmit={saveSettings}>
            <label className="field">
              <span>对话名称</span>
              <input
                required
                maxLength={80}
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
              />
            </label>
            <label className="field">
              <span>场景设定</span>
              <textarea
                maxLength={4000}
                rows={4}
                value={editScene}
                placeholder="写下故事发生的地点与背景…"
                onChange={(event) => setEditScene(event.target.value)}
              />
            </label>
            <label className="field">
              <span>对话模型</span>
              <Select value={editProvider} onValueChange={setEditProvider} aria-label="对话模型">
                <option value="">平台默认模型</option>
                {providers.map((provider) => (
                  <option value={provider.id} key={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </Select>
            </label>
            {error && (
              <div role="alert" className="error-message">
                {error}
              </div>
            )}
            <button className="button button-primary full-width" disabled={saving}>
              {saving ? '正在保存…' : '保存设置'}
              <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
      {memoryOpen && (
        <Modal
          title="留下一条记忆"
          dismissible={!saving}
          onClose={() => {
            if (!saving) setMemoryOpen(false);
          }}
        >
          <form className="stack-form" onSubmit={addMemory}>
            <label className="field">
              <span>记忆属于</span>
              <Select
                value={memoryTarget}
                required
                onValueChange={setMemoryTarget}
                aria-label="记忆属于"
              >
                {currentCharacters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>希望 TA 记住的事</span>
              <textarea
                rows={5}
                required
                maxLength={2000}
                value={memoryContent}
                onChange={(event) => setMemoryContent(event.target.value)}
              />
            </label>
            <p className="muted small">保存后，你与该角色之后的对话都可以使用这条记忆。</p>
            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
            <button
              className="button button-primary full-width"
              disabled={saving || !memoryContent.trim()}
            >
              {saving ? '正在保存…' : '保存记忆'}
              <Bookmark size={16} />
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function ChatMessage({
  message,
  character,
  username,
  streaming = false,
  onRemember,
}: {
  message: Message;
  character?: Character;
  username: string;
  streaming?: boolean;
  onRemember?: (visible: string) => void;
}) {
  const { site } = useSession();
  const mine = message.role === 'user';
  const bubbles = mine
    ? [message.content]
    : splitBubbles(message.content, site?.bubbleSeparator, site?.hiddenOutputMarkers, streaming);
  return (
    <article className={`chat-message ${mine ? 'mine' : 'theirs'}`}>
      <div className="message-avatar">
        {mine ? (
          <span className="user-message-avatar">{username.slice(0, 1)}</span>
        ) : (
          <CharacterAvatar character={character} />
        )}
      </div>
      <div className="message-body">
        <div className="message-author">
          <strong>{mine ? username : character?.name || '角色'}</strong>
          {!mine && <span>AI</span>}
          <time>
            {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        <div className="message-bubbles">
          {bubbles.map((content, bubbleIndex) => (
            <div
              key={bubbleIndex}
              className={`message-bubble ${streaming && bubbleIndex === bubbles.length - 1 ? 'streaming' : ''}`}
            >
              {mine
                ? content
                : content
                    .split(/(\*[^*\n]+\*)/g)
                    .map((part, index) =>
                      part.startsWith('*') && part.endsWith('*') ? (
                        <em key={index}>{part.slice(1, -1)}</em>
                      ) : (
                        part
                      ),
                    )}
              {streaming && bubbleIndex === bubbles.length - 1 && (
                <span className="stream-cursor" />
              )}
            </div>
          ))}
          {!bubbles.length &&
            (streaming ? (
              <div className="message-bubble message-pending" aria-label="正在回应">
                <MoreHorizontal size={19} className="pulse" />
              </div>
            ) : (
              <p className="message-hidden">此条回复没有可显示的内容</p>
            ))}
        </div>
        {onRemember && !streaming && bubbles.length > 0 && (
          <button className="remember-message" onClick={() => onRemember(bubbles.join('\n\n'))}>
            <Bookmark size={12} />
            记住这件事
          </button>
        )}
      </div>
    </article>
  );
}
