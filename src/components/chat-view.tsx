'use client';

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  AtSign,
  BookHeart,
  Check,
  Copy,
  Download,
  ImagePlus,
  LoaderCircle,
  MessageCircle,
  Settings2,
  ShieldCheck,
  Square,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { useApp } from './app-provider';
import { Avatar, Badge, Button, EmptyState, Field, IconButton, Kbd, Modal, Skeleton } from './ui';
import { AuthRequired } from './library';
import { api, copyText, json, newRequestId } from '@/lib/client';
import { actionSegments, messageBubbles, visibleMessage } from '@/lib/display';
import {
  cachedConversation,
  fetchConversation,
  MESSAGE_PAGE_SIZE,
  storeConversation,
} from '@/lib/conversation-cache';
import type {
  Attachment,
  Character,
  ChatEvent,
  ConversationDetail,
  Message,
  PlatformSettings,
} from '@/lib/types';

type Attempt = { content: string; requestId: string; retryOf?: string; attachmentIds?: string[] };
type Draft = { streamId: string; characterId: string; text: string };
type PendingImage = {
  localId: string;
  preview: string;
  status: 'uploading' | 'ready' | 'error';
  attachment?: Attachment;
  error?: string;
};
type DisplaySettings = Partial<PlatformSettings>;

const MAX_UPLOAD_EDGE = 1600;

/** Downscale in the browser so uploads stay small; the server re-encodes again regardless. */
async function prepareImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error('仅支持 JPEG、PNG、WebP 或 GIF 图片。');
  const readRaw = () =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('图片读取失败。'));
      reader.readAsDataURL(file);
    });
  if (file.type === 'image/gif') {
    if (file.size > 6 * 1024 * 1024) throw new Error('GIF 不能超过 6 MiB。');
    return readRaw();
  }
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const webp = canvas.toDataURL('image/webp', 0.86);
    // Safari cannot encode WebP and silently returns PNG; JPEG is far smaller there.
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88);
  } catch {
    if (file.size > 6 * 1024 * 1024) throw new Error('图片不能超过 6 MiB。');
    return readRaw();
  }
}

/** Dialogue and *action* segments of one bubble. */
function BubbleText({ text, settings }: { text: string; settings: DisplaySettings }) {
  const segments = actionSegments(text, settings);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'action' ? (
          <span className="rp-action" key={index}>
            {segment.text}
          </span>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function Bubbles({
  content,
  settings,
  assistant,
  streaming,
}: {
  content: string;
  settings: DisplaySettings;
  assistant: boolean;
  streaming?: boolean;
}) {
  const bubbles = messageBubbles(content, settings, assistant);
  return (
    <>
      {bubbles.map((text, index) => {
        const segments = assistant ? actionSegments(text, settings) : [];
        const narration =
          segments.length > 0 && segments.every((segment) => segment.kind === 'action');
        return (
          <div
            className={`message-bubble ${narration ? 'message-bubble-action' : ''} ${streaming && index === bubbles.length - 1 ? 'message-bubble-streaming' : ''}`}
            key={index}
          >
            {assistant ? <BubbleText text={text} settings={settings} /> : text}
          </div>
        );
      })}
    </>
  );
}

const MessageList = memo(function MessageList({
  messages,
  characters,
  settings,
  userName,
  userAvatar,
  drafts,
  onCopy,
  onOpenImage,
}: {
  messages: Message[];
  characters: Character[];
  settings: DisplaySettings;
  userName: string;
  userAvatar?: string;
  drafts: Draft[];
  onCopy: (content: string) => void;
  onOpenImage: (attachment: Attachment) => void;
}) {
  return (
    <>
      {messages.map((m, index) => {
        const c = characters.find((c) => c.id === m.characterId);
        const assistant = m.role === 'assistant';
        const hasText = messageBubbles(m.content, settings, assistant).length > 0;
        const name = m.role === 'user' ? userName : c?.name || '系统';
        const created = new Date(m.createdAt);
        const previous = messages[index - 1];
        const previousDate = previous ? new Date(previous.createdAt) : null;
        const newDay = !previousDate || previousDate.toDateString() !== created.toDateString();
        // Consecutive messages from the same speaker within five minutes read as one group.
        const continued =
          !newDay &&
          !!previous &&
          previous.role === m.role &&
          previous.characterId === m.characterId &&
          m.role !== 'system' &&
          created.getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;
        const time = created.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        return (
          <Fragment key={m.id}>
            {newDay && (
              <div className="chat-date" role="separator">
                <span>{dayLabel(created)}</span>
              </div>
            )}
            <article
              className={`message message-${m.role} ${continued ? 'message-continued' : ''}`}
              aria-label={`${name} ${time}`}
            >
              {m.role !== 'system' && (
                <Avatar
                  name={name}
                  src={m.role === 'user' ? userAvatar : c?.avatar}
                  color={c?.color}
                  size="small"
                />
              )}
              <div className="message-content">
                <div className="message-author">
                  <span>{name}</span>
                  <time dateTime={m.createdAt} title={created.toLocaleString('zh-CN')}>
                    {time}
                  </time>
                </div>
                {!!m.attachments?.length && (
                  <div
                    className={`message-images message-images-${Math.min(m.attachments.length, 4)}`}
                  >
                    {m.attachments.map((attachment) => (
                      <button
                        type="button"
                        key={attachment.id}
                        className="message-image"
                        onClick={() => onOpenImage(attachment)}
                        aria-label="查看大图"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/attachments/${attachment.id}`}
                          width={attachment.width}
                          height={attachment.height}
                          alt="消息图片"
                          loading="lazy"
                          decoding="async"
                        />
                      </button>
                    ))}
                  </div>
                )}
                <div className="message-bubbles">
                  {hasText ? (
                    <Bubbles content={m.content} settings={settings} assistant={assistant} />
                  ) : m.attachments?.length ? null : (
                    <p className="message-hidden">此消息内容已按平台显示规则隐藏。</p>
                  )}
                </div>
                <div className="message-tools">
                  <IconButton
                    label="复制消息"
                    size="sm"
                    tooltipSide="bottom"
                    disabled={!hasText}
                    onClick={() => onCopy(visibleMessage(m.content, settings, assistant))}
                  >
                    <Copy size={13} />
                  </IconButton>
                </div>
              </div>
            </article>
          </Fragment>
        );
      })}
      {drafts.map((draft) => {
        const c = characters.find((item) => item.id === draft.characterId);
        return (
          <article
            className="message message-assistant message-draft"
            key={draft.streamId}
            aria-busy="true"
            aria-label={`${c?.name || '角色'} 正在输入`}
          >
            <Avatar name={c?.name || '角'} src={c?.avatar} color={c?.color} size="small" />
            <div className="message-content">
              <div className="message-author">
                <span>{c?.name || '角色'}</span>
                <time>正在输入…</time>
              </div>
              <div className="message-bubbles">
                {draft.text ? (
                  <Bubbles content={draft.text} settings={settings} assistant streaming />
                ) : (
                  <div className="message-bubble message-bubble-streaming" />
                )}
              </div>
            </div>
          </article>
        );
      })}
    </>
  );
});

export function ChatView() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, refresh, notify } = useApp();
  const userDisplayName =
    data?.user?.persona?.enabled && data.user.persona.name.trim()
      ? data.user.persona.name
      : data?.user?.name || '我';
  const userId = data?.user?.id;
  const [detail, setDetail] = useState<ConversationDetail | null>(() =>
    userId ? cachedConversation(userId, id) : null,
  );
  const [pending, setPending] = useState(() => !detail);
  const [loadError, setLoadError] = useState('');
  const [olderLoading, setOlderLoading] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [chatError, setChatError] = useState('');
  const [retry, setRetry] = useState<{ attempt: Attempt; replay: boolean } | null>(null);
  const [mentions, setMentions] = useState(false);
  const [info, setInfo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const stream = useRef<AbortController | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const prependAnchor = useRef<number | null>(null);
  const pendingDeltas = useRef(new Map<string, string>());
  const deltaFrame = useRef<number | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const seenCount = useRef(0);
  const sending = useRef(false);
  const settings = data?.settings;

  const load = useCallback(async () => {
    if (!userId) {
      setPending(false);
      setDetail(null);
      return;
    }
    const cached = cachedConversation(userId, id);
    if (cached) {
      setDetail(cached);
      setPending(false);
    } else setPending(true);
    try {
      // Revalidate in the background; a cached view stays interactive meanwhile.
      setDetail(await fetchConversation(userId, id));
      setLoadError('');
    } catch (e) {
      if (!cached) setLoadError((e as Error).message);
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
    if (userId && detail) storeConversation(userId, id, detail);
  }, [detail, id, userId]);
  useEffect(
    () => () => {
      if (deltaFrame.current !== null) cancelAnimationFrame(deltaFrame.current);
    },
    [],
  );

  const loadOlder = useCallback(async () => {
    if (!detail?.hasMore || olderLoading || !detail.messages.length) return;
    setOlderLoading(true);
    try {
      const page = await api<ConversationDetail>(
        `/conversations/${id}?limit=${MESSAGE_PAGE_SIZE}&before=${detail.messages[0].id}`,
      );
      prependAnchor.current = scrollArea.current
        ? scrollArea.current.scrollHeight - scrollArea.current.scrollTop
        : null;
      setDetail((current) =>
        current
          ? {
              ...current,
              hasMore: page.hasMore,
              messages: [
                ...page.messages.filter((m) => !current.messages.some((item) => item.id === m.id)),
                ...current.messages,
              ],
            }
          : current,
      );
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setOlderLoading(false);
    }
  }, [detail, id, notify, olderLoading]);
  // Keep the reading position steady when older messages are prepended.
  useLayoutEffect(() => {
    const el = scrollArea.current;
    if (el && prependAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    }
  }, [detail?.messages.length]);
  useEffect(() => {
    const target = topSentinel.current;
    const root = scrollArea.current;
    if (!target || !root || !detail?.hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
      },
      { root, rootMargin: '240px 0px 0px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [detail?.hasMore, loadOlder]);

  const messageCount = detail?.messages.length || 0;
  const draftLength = drafts.reduce((sum, draft) => sum + draft.text.length, 0);
  useEffect(() => {
    if (prependAnchor.current !== null) return;
    if (autoScroll.current) {
      bottom.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      seenCount.current = messageCount;
      setUnseen(0);
    } else if (messageCount > seenCount.current) {
      setUnseen(messageCount - seenCount.current);
    }
  }, [messageCount, status, draftLength, drafts.length]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = 'auto';
      textarea.current.style.height = `${Math.min(240, Math.max(52, textarea.current.scrollHeight))}px`;
    }
  }, [input]);
  useEffect(
    () => () => {
      for (const image of images) URL.revokeObjectURL(image.preview);
    },
    // Revoke previews only on unmount; removals revoke their own URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  function scrollToLatest() {
    autoScroll.current = true;
    setAwayFromBottom(false);
    setUnseen(0);
    seenCount.current = messageCount;
    bottom.current?.scrollIntoView({
      behavior: document.documentElement.dataset.reduceMotion === 'true' ? 'auto' : 'smooth',
      block: 'end',
    });
  }
  function append(message: Message) {
    setDetail((d) =>
      d
        ? {
            ...d,
            conversation: { ...d.conversation, lastMessage: message.content },
            messages: d.messages.some((m) => m.id === message.id)
              ? d.messages.map((m) => (m.id === message.id ? message : m))
              : [...d.messages, message],
          }
        : d,
    );
  }
  /** Coalesce stream deltas into one render per animation frame. */
  function queueDelta(streamId: string, text: string) {
    pendingDeltas.current.set(streamId, (pendingDeltas.current.get(streamId) || '') + text);
    if (deltaFrame.current !== null) return;
    deltaFrame.current = requestAnimationFrame(() => {
      deltaFrame.current = null;
      const batch = new Map(pendingDeltas.current);
      pendingDeltas.current.clear();
      setDrafts((current) =>
        current.map((draft) =>
          batch.has(draft.streamId)
            ? { ...draft, text: draft.text + batch.get(draft.streamId) }
            : draft,
        ),
      );
    });
  }
  function dropDraft(streamId: string) {
    pendingDeltas.current.delete(streamId);
    setDrafts((current) => current.filter((draft) => draft.streamId !== streamId));
  }

  const maxImages = settings?.maxImagesPerMessage ?? 4;
  const imageInputEnabled = settings?.imageInputEnabled !== false;
  async function addImages(files: File[]) {
    if (!imageInputEnabled || !files.length) return;
    const room = maxImages - images.length;
    if (room <= 0) {
      notify(`每条消息最多附带 ${maxImages} 张图片。`, 'error');
      return;
    }
    const accepted = files.filter((file) => file.type.startsWith('image/')).slice(0, room);
    if (files.length > room) notify(`每条消息最多附带 ${maxImages} 张图片。`, 'error');
    for (const file of accepted) {
      const localId = newRequestId();
      const previewUrl = URL.createObjectURL(file);
      setImages((current) => [...current, { localId, preview: previewUrl, status: 'uploading' }]);
      void (async () => {
        try {
          const dataUrl = await prepareImage(file);
          const attachment = await api<Attachment>(
            `/conversations/${id}/attachments`,
            json('POST', { dataUrl }),
          );
          setImages((current) =>
            current.map((image) =>
              image.localId === localId ? { ...image, status: 'ready', attachment } : image,
            ),
          );
        } catch (e) {
          setImages((current) =>
            current.map((image) =>
              image.localId === localId
                ? { ...image, status: 'error', error: (e as Error).message }
                : image,
            ),
          );
        }
      })();
    }
  }
  function removeImage(localId: string) {
    setImages((current) => {
      const target = current.find((image) => image.localId === localId);
      if (target) {
        URL.revokeObjectURL(target.preview);
        if (target.attachment)
          void api(`/attachments/${target.attachment.id}`, json('DELETE')).catch(() => undefined);
      }
      return current.filter((image) => image.localId !== localId);
    });
  }
  function clearSentImages(ids: string[]) {
    setImages((current) => {
      for (const image of current)
        if (image.attachment && ids.includes(image.attachment.id))
          URL.revokeObjectURL(image.preview);
      return current.filter((image) => !image.attachment || !ids.includes(image.attachment.id));
    });
  }

  async function send(attempt: Attempt) {
    if (sending.current || (!attempt.content.trim() && !attempt.attachmentIds?.length)) return;
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
    const openDrafts = new Set<string>();
    try {
      const response = await fetch(`/api/conversations/${id}/messages`, {
        ...json('POST', {
          content: attempt.content,
          requestId: attempt.requestId,
          ...(attempt.retryOf ? { retryOf: attempt.retryOf } : {}),
          ...(attempt.attachmentIds?.length ? { attachmentIds: attempt.attachmentIds } : {}),
        }),
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
          if (attempt.attachmentIds?.length) clearSentImages(attempt.attachmentIds);
          append(event.message);
        }
        if (event.type === 'status') setStatus(event.text);
        if (event.type === 'stream-start') {
          openDrafts.add(event.streamId);
          setDrafts((current) => [
            ...current.filter((draft) => draft.streamId !== event.streamId),
            { streamId: event.streamId, characterId: event.characterId, text: '' },
          ]);
        }
        if (event.type === 'delta') queueDelta(event.streamId, event.text);
        if (event.type === 'stream-end') {
          openDrafts.delete(event.streamId);
          dropDraft(event.streamId);
        }
        if (event.type === 'message') {
          replied++;
          if (event.streamId) {
            openDrafts.delete(event.streamId);
            dropDraft(event.streamId);
          }
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
      for (const streamId of openDrafts) dropDraft(streamId);
      sending.current = false;
      setBusy(false);
      setStatus('');
      stream.current = null;
      // Quota and the sidebar refresh in the background; the stream already delivered every message.
      void refresh();
      if (!sawDone && (sawUser || replied) && userId) {
        try {
          setDetail(await fetchConversation(userId, id));
        } catch {
          /* The message stream remains usable when a follow-up refresh fails. */
        }
      }
      textarea.current?.focus();
    }
  }
  const uploading = images.some((image) => image.status === 'uploading');
  const readyImages = images.filter((image) => image.status === 'ready' && image.attachment);
  function submit(e?: FormEvent) {
    e?.preventDefault();
    if ((!input.trim() && !readyImages.length) || busy || uploading) return;
    void send({
      content: input.trim(),
      requestId: newRequestId(),
      attachmentIds: readyImages.map((image) => image.attachment!.id),
    });
  }
  function keydown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') setMentions(false);
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !mentions) {
      e.preventDefault();
      submit();
    }
  }
  function paste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files].filter((file) => file.type.startsWith('image/'));
    if (!files.length || !imageInputEnabled) return;
    e.preventDefault();
    void addImages(files);
  }
  function drop(e: DragEvent<HTMLFormElement>) {
    if (!imageInputEnabled) return;
    e.preventDefault();
    setDragging(false);
    void addImages([...e.dataTransfer.files]);
  }
  function mention(slug: string) {
    setInput((value) => `${value.replace(/@[^\s@]*$/, '')}@${slug} `);
    setMentions(false);
    textarea.current?.focus();
  }
  const copy = useCallback(
    async (content: string) => {
      try {
        await copyText(content);
        notify('消息已复制。');
      } catch {
        notify('浏览器未允许复制，请手动选中消息。', 'error');
      }
    },
    [notify],
  );
  const openImage = useCallback((attachment: Attachment) => setPreview(attachment), []);
  async function exportConversation() {
    if (!detail) return;
    let all = detail.messages;
    if (detail.hasMore) {
      try {
        all = (await api<ConversationDetail>(`/conversations/${id}`)).messages;
      } catch (e) {
        notify((e as Error).message, 'error');
        return;
      }
    }
    const text = [
      `# ${detail.conversation.title}`,
      '',
      ...all.map(
        (m) =>
          `## ${m.role === 'user' ? userDisplayName : detail.characters.find((c) => c.id === m.characterId)?.name || '系统'} · ${new Date(m.createdAt).toLocaleString('zh-CN')}\n\n${visibleMessage(m.content, data?.settings, m.role === 'assistant')}${m.attachments?.length ? `\n\n（附图 ${m.attachments.length} 张）` : ''}\n`,
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
  if ((loading || pending) && !detail) return <ChatSkeleton />;
  if (!data?.user)
    return (
      <div style={{ padding: 28 }}>
        <AuthRequired />
      </div>
    );
  if (loadError || !detail)
    return (
      <div className="chat-load-error">
        <EmptyState
          icon={<TriangleAlert size={22} strokeWidth={1.7} />}
          title="无法打开对话"
          description={loadError || '对话不存在，或你没有访问权限。'}
          action={
            <>
              <Link href="/conversations" className="button button-secondary">
                返回对话列表
              </Link>
              <Button onClick={load}>重新加载</Button>
            </>
          }
        />
      </div>
    );
  const { conversation, characters, messages } = detail;
  const firstCharacter = characters[0];
  const isGroup = conversation.kind === 'group';
  const mentionedQuery = (input.match(/@([^\s@]*)$/)?.[1] || '').toLowerCase();
  const mentionCharacters = characters.filter(
    (c) =>
      c.active &&
      data.characters.some((available) => available.id === c.id) &&
      (c.name.toLowerCase().includes(mentionedQuery) ||
        c.slug.toLowerCase().includes(mentionedQuery)),
  );
  const visionHint = !isGroup && firstCharacter && firstCharacter.imageInput === false;
  return (
    <div className="chat-workspace">
      <header className="chat-header">
        <Link
          className="icon-button chat-back"
          href="/conversations"
          aria-label="返回对话列表"
          data-tooltip="返回对话列表"
          data-tooltip-side="bottom"
        >
          <ArrowLeft size={18} />
        </Link>
        <Avatar
          name={isGroup ? '群' : firstCharacter?.name || '角'}
          src={isGroup ? undefined : firstCharacter?.avatar}
          color={firstCharacter?.color}
        />
        <div className="chat-header-info">
          <h1>{conversation.title}</h1>
          <span>
            {isGroup ? (
              <Users size={12} aria-hidden="true" />
            ) : (
              <MessageCircle size={12} aria-hidden="true" />
            )}
            {isGroup
              ? `${characters.length} 个角色 · 每条消息最多 ${conversation.maxRounds} 轮回复`
              : '私聊'}
          </span>
        </div>
        <div className="chat-header-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={exportConversation}
            aria-label="导出对话"
            data-tooltip="导出为 Markdown"
            data-tooltip-side="bottom"
          >
            <Download size={16} />
            <span className="chat-action-text">导出</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setInfo(true)}
            aria-label="对话设置"
            data-tooltip="对话设置"
            data-tooltip-side="bottom"
          >
            <Settings2 size={16} />
            <span className="chat-action-text">设置</span>
          </Button>
        </div>
      </header>
      <div
        className="chat-messages"
        ref={scrollArea}
        onScroll={() => {
          const el = scrollArea.current;
          if (!el) return;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
          autoScroll.current = near;
          setAwayFromBottom(!near);
          if (near) {
            seenCount.current = messageCount;
            setUnseen(0);
          }
        }}
        aria-label="消息记录"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {detail.hasMore && (
          <div className="chat-older" ref={topSentinel}>
            <button
              type="button"
              className="text-button"
              onClick={() => void loadOlder()}
              disabled={olderLoading}
            >
              {olderLoading ? (
                <>
                  <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  正在加载更早的消息…
                </>
              ) : (
                '加载更早的消息'
              )}
            </button>
          </div>
        )}
        {messages.length || drafts.length ? (
          <MessageList
            messages={messages}
            characters={characters}
            settings={data.settings}
            userName={userDisplayName}
            userAvatar={data.user?.avatar}
            drafts={drafts}
            onCopy={copy}
            onOpenImage={openImage}
          />
        ) : (
          <div className="chat-empty">
            <div className="chat-empty-avatars">
              {characters.map((c) => (
                <Avatar key={c.id} name={c.name} src={c.avatar} color={c.color} size="large" />
              ))}
            </div>
            <h2>{isGroup ? '群聊已创建' : firstCharacter?.name || '新对话'}</h2>
            <p>
              {isGroup ? (
                '在消息中 @角色名，指定由谁回复。'
              ) : firstCharacter?.greeting ? (
                <BubbleText
                  text={visibleMessage(firstCharacter.greeting, data.settings)}
                  settings={data.settings}
                />
              ) : (
                '发送第一条消息开始对话。'
              )}
            </p>
            <div className="chat-suggestions">
              {(isGroup
                ? [`@${firstCharacter?.slug || ''} 你好`, '大家好']
                : ['你好', '介绍一下你自己', '最近在忙什么？']
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
        {busy && !drafts.length && (
          <div className="chat-status" role="status">
            {!isGroup && firstCharacter && (
              <Avatar
                name={firstCharacter.name}
                src={firstCharacter.avatar}
                color={firstCharacter.color}
                size="small"
              />
            )}
            <span className="chat-status-bubble">
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {status || '正在回复…'}
            </span>
          </div>
        )}
        <div ref={bottom} className="chat-bottom-anchor" />
      </div>
      {awayFromBottom && (
        <button
          type="button"
          className={`scroll-latest ${unseen ? 'scroll-latest-new' : ''}`}
          onClick={scrollToLatest}
          aria-label={unseen ? `有 ${unseen} 条新消息，回到底部` : '回到最新消息'}
        >
          <ArrowDown size={15} aria-hidden="true" />
          {unseen ? `${unseen} 条新消息` : '回到底部'}
        </button>
      )}
      <div className="chat-composer-area">
        {chatError && (
          <div className="chat-error" role="alert">
            <span>{chatError}</span>
            <TriangleAlert size={16} aria-hidden="true" />
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
                        attachmentIds: retry.attempt.attachmentIds,
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
        <form
          className={`chat-composer ${dragging ? 'chat-composer-dragging' : ''}`}
          onSubmit={submit}
          onDragOver={(e) => {
            if (!imageInputEnabled || busy || !e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
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
          {!!images.length && (
            <div className="composer-images" aria-label="待发送的图片">
              {images.map((image) => (
                <div
                  key={image.localId}
                  className={`composer-image composer-image-${image.status}`}
                  title={image.error}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.preview} alt="待发送图片" />
                  {image.status === 'uploading' && (
                    <span className="composer-image-state">
                      <LoaderCircle size={16} className="spin" aria-label="上传中" />
                    </span>
                  )}
                  {image.status === 'error' && (
                    <span className="composer-image-state">
                      <TriangleAlert size={16} aria-label={image.error || '上传失败'} />
                    </span>
                  )}
                  <button
                    type="button"
                    className="composer-image-remove"
                    aria-label="移除图片"
                    disabled={busy}
                    onClick={() => removeImage(image.localId)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {visionHint && (
                <p className="composer-image-hint">
                  当前角色的模型未标记识图能力，图片会以文字占位发送。
                </p>
              )}
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="消息内容"
            placeholder={
              isGroup ? '输入消息，@角色名 指定回复' : `给${firstCharacter?.name || '角色'}发消息`
            }
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setMentions(isGroup && /@[^\s@]*$/.test(e.target.value));
            }}
            onKeyDown={keydown}
            onPaste={paste}
            maxLength={20000}
            disabled={busy}
            rows={1}
          />
          <div className="composer-bottom">
            <div className="composer-hints">
              {imageInputEnabled && (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="添加图片"
                    data-tooltip={`添加图片（最多 ${maxImages} 张，可粘贴或拖入）`}
                    disabled={busy || images.length >= maxImages}
                    onClick={() => fileInput.current?.click()}
                  >
                    <ImagePlus size={17} />
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    hidden
                    onChange={(e) => {
                      void addImages([...(e.target.files || [])]);
                      e.target.value = '';
                    }}
                  />
                </>
              )}
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
                  <AtSign size={17} />
                </button>
              )}
              <span className="composer-shortcuts">
                <Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> 换行
              </span>
              {input.length > 15000 && (
                <span className={`composer-count ${input.length > 19500 ? 'over' : ''}`}>
                  {input.length.toLocaleString()}/20,000
                </span>
              )}
            </div>
            {busy ? (
              <Button
                className="send-button"
                variant="secondary"
                type="button"
                onClick={() => stream.current?.abort()}
              >
                <Square size={11} fill="currentColor" aria-hidden="true" />
                停止
              </Button>
            ) : (
              <Button
                type="submit"
                className="send-button"
                disabled={(!input.trim() && !readyImages.length) || uploading}
                aria-keyshortcuts="Enter"
              >
                {uploading ? '上传中' : '发送'}
                <ArrowUp size={15} aria-hidden="true" />
              </Button>
            )}
          </div>
        </form>
        <div className="chat-disclaimer">
          {data.settings.auditCaptureContent ? (
            <span>
              <ShieldCheck size={12} aria-hidden="true" />
              本平台会记录请求内容用于审查
            </span>
          ) : (
            <span />
          )}
          <span>
            角色回复由 AI 生成 ·{' '}
            {data.quota ? `5h 剩余 ${data.quota.fiveHour.remaining} 次` : '登录后计入额度'}
          </span>
        </div>
      </div>
      <Modal open={!!preview} onClose={() => setPreview(null)} title="查看图片" wide>
        {preview && (
          <div className="image-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/attachments/${preview.id}`}
              width={preview.width}
              height={preview.height}
              alt="消息图片大图"
            />
            <a
              className="text-button"
              href={`/api/attachments/${preview.id}`}
              target="_blank"
              rel="noreferrer"
            >
              在新标签页打开原图
            </a>
          </div>
        )}
      </Modal>
      <Modal
        open={info}
        onClose={() => !saving && setInfo(false)}
        title="对话设置"
        description={isGroup ? '群聊名称与回复轮数。' : '对话名称与角色记忆。'}
      >
        <form className="form-stack" onSubmit={saveInfo} key={conversation.updatedAt}>
          <Field label="对话名称">
            <input name="title" defaultValue={conversation.title} maxLength={80} required />
          </Field>
          {isGroup && (
            <Field
              label="每条消息的最多回复轮数"
              hint="包括被 @ 的角色和角色之间的接话，每次回复单独计入额度。"
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
            管理记忆
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

function dayLabel(date: Date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
  });
}

export function ChatSkeleton() {
  return (
    <div className="chat-workspace chat-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">正在加载对话…</span>
      <div className="chat-header" aria-hidden="true">
        <Skeleton width={32} height={32} radius={8} />
        <Skeleton width={36} height={36} radius={10} />
        <span className="chat-header-info">
          <Skeleton width={160} height={14} />
          <Skeleton width={220} height={10} />
        </span>
      </div>
      <div className="chat-messages" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div className={`skeleton-message ${i === 1 ? 'skeleton-message-user' : ''}`} key={i}>
            <Skeleton width={32} height={32} radius={10} />
            <div className="skeleton-message-body">
              <Skeleton width={i === 1 ? 180 : 320} height={44} radius={14} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
