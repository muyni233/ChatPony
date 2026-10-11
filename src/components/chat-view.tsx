'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  AtSign,
  BookHeart,
  Check,
  Copy,
  Download,
  MessageCircle,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Users,
  X,
} from 'lucide-react';
import { useApp } from './app-provider';
import { Avatar, Badge, Button, EmptyState, Field, Modal } from './ui';
import { AuthRequired, Loading } from './library';
import { api, copyText, json, newRequestId } from '@/lib/client';
import { messageBubbles, visibleMessage } from '@/lib/display';
import type { ChatEvent, ConversationDetail, Message } from '@/lib/types';

type Attempt = { content: string; requestId: string; retryOf?: string };
export function ChatView() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, refresh, notify } = useApp();
  const userDisplayName =
    data?.user?.persona?.enabled && data.user.persona.name.trim()
      ? data.user.persona.name
      : data?.user?.name || '我';
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [pending, setPending] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [chatError, setChatError] = useState('');
  const [retry, setRetry] = useState<{ attempt: Attempt; replay: boolean } | null>(null);
  const [mentions, setMentions] = useState(false);
  const [info, setInfo] = useState(false);
  const [saving, setSaving] = useState(false);
  const stream = useRef<AbortController | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const sending = useRef(false);
  const userId = data?.user?.id;
  const load = useCallback(async () => {
    if (!userId) {
      setPending(false);
      setDetail(null);
      return;
    }
    setPending(true);
    try {
      setDetail(await api<ConversationDetail>(`/conversations/${id}`));
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setPending(false);
    }
  }, [id, userId]);
  useEffect(() => {
    void load();
    return () => {
      stream.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    if (autoScroll.current) bottom.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [detail?.messages.length, status]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto';
      textarea.current.style.height = `${Math.min(220, Math.max(77, textarea.current.scrollHeight))}px`;
    }
  }, [input]);
  function append(message: Message) {
    setDetail((d) =>
      d
        ? {
            ...d,
            messages: d.messages.some((m) => m.id === message.id)
              ? d.messages
              : [...d.messages, message],
          }
        : d,
    );
  }
  async function send(attempt: Attempt) {
    if (sending.current || !attempt.content.trim()) return;
    sending.current = true;
    setBusy(true);
    setMentions(false);
    setChatError('');
    setRetry(null);
    setStatus('正在发送…');
    autoScroll.current = true;
    const controller = new AbortController();
    stream.current = controller;
    let sawDone = false;
    let sawUser = false;
    let generationError = false;
    let replied = 0;
    try {
      const response = await fetch(`/api/conversations/${id}/messages`, {
        ...json('POST', attempt),
        signal: controller.signal,
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error?.message || '消息暂时无法发送，请稍后重试。');
      }
      if (!response.body) throw new Error('连接未建立，请重试。');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      function event(event: ChatEvent) {
        if (event.type === 'user') {
          sawUser = true;
          setInput((current) => (current.trim() === attempt.content.trim() ? '' : current));
          append(event.message);
        }
        if (event.type === 'status') setStatus(event.text);
        if (event.type === 'message') {
          replied++;
          append(event.message);
        }
        if (event.type === 'error') {
          generationError = true;
          setChatError(event.message);
        }
        if (event.type === 'done') {
          sawDone = true;
          if (event.limited && !generationError) notify('已达到本次群聊响应轮数上限。');
          if (generationError && event.rounds === 0) setRetry({ attempt, replay: false });
        }
      }
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() || '';
          for (const part of parts) {
            const payload = part
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (payload) event(JSON.parse(payload) as ChatEvent);
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!sawDone) {
        setChatError('连接已中断。可以同步这次请求的结果，避免重复发送。');
        setRetry({ attempt, replay: true });
      }
    } catch (e) {
      if (controller.signal.aborted) {
        setChatError('本次生成已停止。已保存的消息将保留。');
        setRetry({ attempt, replay: true });
      } else {
        setChatError((e as Error).message);
        if (!sawUser) setInput(attempt.content);
        setRetry({ attempt, replay: true });
      }
    } finally {
      sending.current = false;
      setBusy(false);
      setStatus('');
      stream.current = null;
      await refresh();
      if (sawUser || replied) {
        try {
          const latest = await api<ConversationDetail>(`/conversations/${id}`);
          setDetail(latest);
        } catch {
          /* The message stream remains usable when a follow-up refresh fails. */
        }
      }
      textarea.current?.focus();
    }
  }
  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!input.trim() || busy) return;
    void send({ content: input.trim(), requestId: newRequestId() });
  }
  function keydown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') setMentions(false);
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !mentions) {
      e.preventDefault();
      submit();
    }
  }
  function mention(slug: string) {
    setInput((value) => `${value.replace(/@[^\s@]*$/, '')}@${slug} `);
    setMentions(false);
    textarea.current?.focus();
  }
  async function copy(content: string) {
    try {
      await copyText(content);
      notify('消息已复制。');
    } catch {
      notify('浏览器未允许复制，请手动选中消息。', 'error');
    }
  }
  function exportConversation() {
    if (!detail) return;
    const text = [
      `# ${detail.conversation.title}`,
      '',
      ...detail.messages.map(
        (m) =>
          `## ${m.role === 'user' ? userDisplayName : detail.characters.find((c) => c.id === m.characterId)?.name || '系统'} · ${new Date(m.createdAt).toLocaleString('zh-CN')}\n\n${visibleMessage(m.content, data?.settings, m.role === 'assistant')}\n`,
      ),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${detail.conversation.title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('对话记录已导出。');
  }
  async function saveInfo(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    setSaving(true);
    try {
      await api(
        `/conversations/${id}`,
        json('PATCH', {
          title: fields.get('title'),
          ...(detail?.conversation.kind === 'group'
            ? { maxRounds: Number(fields.get('maxRounds')) }
            : {}),
        }),
      );
      await load();
      await refresh();
      setInfo(false);
      notify('对话设置已保存。');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }
  if (loading || pending) return <Loading />;
  if (!data?.user)
    return (
      <div style={{ padding: 28 }}>
        <AuthRequired />
      </div>
    );
  if (loadError || !detail)
    return (
      <EmptyState
        title="暂时无法打开这段对话"
        description={loadError || '对话不存在，或你没有访问权限。'}
        action={<Button onClick={load}>重新加载</Button>}
      />
    );
  const { conversation, characters, messages } = detail;
  const firstCharacter = characters[0];
  const isGroup = conversation.kind === 'group';
  const mentionedQuery = (input.match(/@([^\s@]*)$/)?.[1] || '').toLowerCase();
  const mentionCharacters = characters.filter(
    (c) =>
      c.name.toLowerCase().includes(mentionedQuery) ||
      c.slug.toLowerCase().includes(mentionedQuery),
  );
  return (
    <div className="chat-workspace">
      <header className="chat-header">
        <Link className="icon-button" href="/conversations" aria-label="返回对话列表">
          <ArrowLeft size={19} />
        </Link>
        <Avatar
          name={isGroup ? '群' : firstCharacter?.name || '角'}
          src={isGroup ? undefined : firstCharacter?.avatar}
          color={firstCharacter?.color}
        />
        <div className="chat-header-info">
          <h1>{conversation.title}</h1>
          <span>
            {isGroup ? <Users size={11} /> : <MessageCircle size={11} />}
            {isGroup
              ? `${characters.length} 位角色 · @ 角色后触发响应 · 最多 ${conversation.maxRounds} 轮`
              : `${firstCharacter?.name || '角色'} · 记忆按角色独立保存`}
          </span>
        </div>
        <div className="chat-header-actions">
          <Button variant="ghost" onClick={exportConversation} aria-label="导出对话">
            <Download size={16} />
            导出
          </Button>
          <Button variant="ghost" onClick={() => setInfo(true)} aria-label="对话设置">
            <Settings2 size={17} />
            设置
          </Button>
        </div>
      </header>
      <div
        className="chat-messages"
        ref={scrollArea}
        onScroll={() => {
          const el = scrollArea.current;
          if (el) autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        }}
        aria-label="聊天记录"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.length ? (
          <>
            <div className="chat-date">
              {new Date(conversation.createdAt).toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
              })}{' '}
              · 故事开始的日子
            </div>
            {messages.map((m) => {
              const c = characters.find((c) => c.id === m.characterId);
              const bubbles = messageBubbles(m.content, data.settings, m.role === 'assistant');
              const name = m.role === 'user' ? userDisplayName : c?.name || '系统';
              return (
                <article className={`message message-${m.role}`} key={m.id}>
                  {m.role !== 'system' && (
                    <Avatar
                      name={name}
                      src={m.role === 'user' ? data.user?.avatar : c?.avatar}
                      color={c?.color}
                    />
                  )}
                  <div className="message-content">
                    <div className="message-author">
                      <span>{name}</span>
                      <time>
                        {new Date(m.createdAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    <div className="message-bubbles">
                      {bubbles.length ? (
                        bubbles.map((text, index) => (
                          <div className="message-bubble" key={index}>
                            {text}
                          </div>
                        ))
                      ) : (
                        <p className="message-hidden">此消息内容已按平台显示规则隐藏。</p>
                      )}
                    </div>
                    <div className="message-tools">
                      <button
                        className="icon-button"
                        aria-label="复制消息"
                        disabled={!bubbles.length}
                        onClick={() =>
                          copy(visibleMessage(m.content, data.settings, m.role === 'assistant'))
                        }
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </>
        ) : (
          <div className="chat-empty">
            <div className="chat-empty-avatars">
              {characters.map((c) => (
                <Avatar key={c.id} name={c.name} src={c.avatar} color={c.color} size="large" />
              ))}
            </div>
            <h2>
              {isGroup ? '朋友到齐，故事开始。' : `和${firstCharacter?.name || '新朋友'}，聊聊吧。`}
            </h2>
            <p>
              {isGroup
                ? '在消息中 @角色名称或标识，即可邀请对方回应。\n也可以先写下故事的开场，之后再邀请角色加入。'
                : visibleMessage(firstCharacter?.greeting || '', data.settings) ||
                  '从一句简单的问候开始，\n让日常多一点陪伴，让故事慢慢发生。'}
            </p>
            <div className="chat-suggestions">
              {(isGroup
                ? [`@${firstCharacter?.slug || ''} 大家好！`, '今天，我们一起去冒险吧。']
                : ['你好，很高兴认识你！', '今天有什么有趣的事吗？', '想和你分享一下我的一天。']
              ).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setInput(s);
                    textarea.current?.focus();
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {busy && (
          <div className="chat-status">
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
            {status || '正在准备回应…'}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="chat-composer-area">
        {chatError && (
          <div className="chat-error" role="alert">
            <span>{chatError}</span>
            {retry && !busy && (
              <button
                className="text-button"
                onClick={() => {
                  const attempt = retry.replay
                    ? retry.attempt
                    : {
                        content: retry.attempt.content,
                        requestId: newRequestId(),
                        retryOf: retry.attempt.requestId,
                      };
                  void send(attempt);
                }}
              >
                {retry.replay ? '同步结果' : '重新生成'}
              </button>
            )}
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => {
                setChatError('');
                setRetry(null);
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <form className="chat-composer" onSubmit={submit}>
          {mentions && isGroup && (
            <div className="mention-menu" aria-label="选择提及的角色">
              {mentionCharacters.length ? (
                mentionCharacters.map((c) => (
                  <button key={c.id} type="button" onClick={() => mention(c.slug)}>
                    <Avatar name={c.name} src={c.avatar} color={c.color} size="small" />
                    {c.name}
                    <small>@{c.slug}</small>
                  </button>
                ))
              ) : (
                <p className="field-hint">没有匹配的角色</p>
              )}
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="消息内容"
            placeholder={
              isGroup
                ? '说点什么… 输入 @ 邀请角色回应'
                : `发送消息给${firstCharacter?.name || '角色'}…`
            }
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setMentions(isGroup && /@[^\s@]*$/.test(e.target.value));
            }}
            onKeyDown={keydown}
            maxLength={20000}
            disabled={busy}
            rows={2}
          />
          <div className="composer-bottom">
            <div className="composer-hints">
              {isGroup && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="提及角色"
                  disabled={busy}
                  onClick={() => {
                    setMentions(!mentions);
                    textarea.current?.focus();
                  }}
                >
                  <AtSign size={18} />
                </button>
              )}
              <span>Enter 发送 · Shift + Enter 换行</span>
              {input.length > 15000 && <span>{input.length}/20000</span>}
            </div>
            {busy ? (
              <Button
                className="send-button"
                variant="secondary"
                type="button"
                onClick={() => stream.current?.abort()}
              >
                <Square size={12} />
                停止
              </Button>
            ) : (
              <Button type="submit" className="send-button" disabled={!input.trim()}>
                发送
                <Send size={15} />
              </Button>
            )}
          </div>
        </form>
        <div className="chat-disclaimer">
          <span>
            <ShieldCheck size={11} />
            {data.settings.auditCaptureContent
              ? '平台已启用请求正文审计'
              : '对话与记忆按账户独立保存'}
          </span>
          <span>
            AI 生成的角色回复属于虚构内容 ·{' '}
            {data.quota ? `5h 剩余 ${data.quota.fiveHour.remaining} 次` : '按成功调用计次'}
          </span>
        </div>
      </div>
      <Modal
        open={info}
        onClose={() => !saving && setInfo(false)}
        title="对话设置"
        description={isGroup ? '管理群聊名称与角色响应轮数。' : '管理这段对话的名称与记忆。'}
      >
        <form className="form-stack" onSubmit={saveInfo} key={conversation.updatedAt}>
          <Field label="对话名称">
            <input name="title" defaultValue={conversation.title} maxLength={80} required />
          </Field>
          {isGroup && (
            <Field
              label="每次消息的最大响应轮数"
              hint="包含最初被 @ 的角色与角色接力，每位角色的响应都单独计次。"
            >
              <input
                name="maxRounds"
                type="number"
                min={1}
                max={data.settings.maxGroupRounds}
                defaultValue={conversation.maxRounds}
                required
              />
            </Field>
          )}
          <div>
            <span className="field-label">对话成员</span>
            <div className="chat-info-members">
              {characters.map((c) => (
                <div key={c.id}>
                  <Avatar name={c.name} src={c.avatar} color={c.color} size="small" />
                  <span>
                    {c.name}
                    <small>@{c.slug}</small>
                  </span>
                  {!c.active && <Badge>已停用</Badge>}
                </div>
              ))}
            </div>
          </div>
          {conversation.summary && (
            <div>
              <span className="field-label">历史摘要</span>
              <p className="field-hint">
                为保持上下文连贯，较早的消息已压缩为摘要。原始记录仍完整保留。
              </p>
              <div className="summary-box">
                {visibleMessage(conversation.summary, data.settings)}
              </div>
            </div>
          )}
          <Link href="/memories" className="text-button" onClick={() => setInfo(false)}>
            <BookHeart size={16} />
            管理角色长期记忆
          </Link>
          <div className="modal-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setInfo(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button type="submit" loading={saving}>
              <Check size={16} />
              保存设置
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
