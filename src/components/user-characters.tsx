'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
} from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Camera,
  Check,
  CircleHelp,
  LockKeyhole,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from './app-provider';
import { AuthRequired, Loading, PageHeading } from './library';
import { NewChat } from './new-chat';
import { Avatar, Badge, Button, EmptyState, Field, Modal, Select } from './ui';
import { api, json } from '@/lib/client';
import type { Character, UserCharacters } from '@/lib/types';
import './user-characters.css';

type CharacterCollection = UserCharacters;

export function UserCharactersPage() {
  const { data, loading, refresh, notify } = useApp();
  const user = data?.user;
  const [collection, setCollection] = useState<CharacterCollection | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ item?: Character } | null>(null);
  const [remove, setRemove] = useState<Character | null>(null);
  const [selected, setSelected] = useState<Character | null>(null);
  const requestSequence = useRef(0);
  const load = useCallback(async () => {
    if (!user?.id) return;
    const sequence = ++requestSequence.current;
    setFetching(true);
    try {
      const next = await api<CharacterCollection>('/account/characters');
      if (sequence === requestSequence.current) {
        setCollection(next);
        setError('');
      }
    } catch (reason) {
      if (sequence === requestSequence.current) setError((reason as Error).message);
    } finally {
      if (sequence === requestSequence.current) setFetching(false);
    }
  }, [user?.id]);

  useEffect(() => {
    setCollection(null);
    setEditor(null);
    setRemove(null);
    setSelected(null);
    if (user?.id) void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load, user?.id]);

  useEffect(() => {
    if (collection && user && collection.slots.limit !== user.characterSlots) void load();
  }, [user?.characterSlots, collection?.slots.limit, load]); // Refresh slots when an administrator changes them.

  const items = (collection?.items || []).filter((character) =>
    `${character.name} ${character.description} ${character.tags.join(' ')}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const slots = collection?.slots;
  const canCreate = !!slots && slots.remaining > 0;

  async function saved(character: Character) {
    setEditor(null);
    setCollection((previous) => {
      if (!previous) return previous;
      const exists = previous.items.some((item) => item.id === character.id);
      const used = previous.slots.used + (exists ? 0 : 1);
      return {
        ...previous,
        items: exists
          ? previous.items.map((item) => (item.id === character.id ? character : item))
          : [character, ...previous.items],
        slots: { ...previous.slots, used, remaining: Math.max(0, previous.slots.limit - used) },
      };
    });
    await Promise.all([load(), refresh()]);
    notify(
      character.active ? '角色已保存，仅你自己可以使用。' : '角色草稿已保存，启用后即可开始对话。',
    );
  }

  async function removed(character: Character) {
    setRemove(null);
    setCollection((previous) => {
      if (!previous) return previous;
      const used = Math.max(0, previous.slots.used - 1);
      return {
        ...previous,
        items: previous.items.filter((item) => item.id !== character.id),
        slots: { ...previous.slots, used, remaining: Math.max(0, previous.slots.limit - used) },
      };
    });
    await Promise.all([load(), refresh()]);
    notify('角色已删除，槽位已释放。已有对话和记忆仍会保留。');
  }

  return (
    <div className="page-enter private-characters-page">
      <PageHeading
        eyebrow="YOUR PRIVATE CHARACTERS"
        title="我的角色"
        description="编写人设，选择模型，创建只属于你的对话角色。"
        action={
          user ? (
            <Button onClick={() => setEditor({})} disabled={!canCreate || fetching}>
              <Plus size={16} />
              创建角色
            </Button>
          ) : undefined
        }
      />
      {loading ? (
        <Loading />
      ) : !user ? (
        <AuthRequired
          title="创建只属于你的角色"
          description="登录后可以创建与管理自己的私有角色，用于私聊和群聊。"
        />
      ) : (
        <>
          {error && (
            <div className="private-characters-error form-error" role="alert">
              <span>{error}</span>
              <Button variant="ghost" loading={fetching} onClick={() => void load()}>
                <RefreshCw size={15} />
                重新加载
              </Button>
            </div>
          )}
          {!collection && fetching ? (
            <Loading />
          ) : (
            collection && (
              <>
                <section className="private-slot-card paper-card" aria-label="角色槽位">
                  <div className="private-slot-heading">
                    <span className="private-slot-icon">
                      <LockKeyhole size={22} strokeWidth={1.6} />
                    </span>
                    <div>
                      <h2>仅自己可见</h2>
                      <p>角色不会展示在角色广场，可加入你的私聊与群聊。</p>
                    </div>
                  </div>
                  <div className="private-slot-usage">
                    <div>
                      <span>角色槽位</span>
                      <strong>
                        {slots?.used}
                        <small> / {slots?.limit}</small>
                      </strong>
                    </div>
                    <div
                      className="private-slot-meter"
                      role="progressbar"
                      aria-label="已使用角色槽位"
                      aria-valuenow={Math.min(slots!.used, slots!.limit)}
                      aria-valuemin={0}
                      aria-valuemax={Math.max(1, slots!.limit)}
                    >
                      <span
                        style={{
                          width: `${slots!.limit ? Math.min(100, (slots!.used / slots!.limit) * 100) : slots!.used ? 100 : 0}%`,
                        }}
                      />
                    </div>
                    <p>
                      {slots!.used > slots!.limit
                        ? `已超出当前上限 ${slots!.used - slots!.limit} 个，现有角色仍可使用。`
                        : slots!.limit === 0
                          ? '管理员暂未分配创建槽位。'
                          : slots!.remaining === 0
                            ? '槽位已满，可编辑已有角色，或删除后再创建。'
                            : `还可创建 ${slots!.remaining} 个角色。`}
                      <span>停用角色也占槽位，删除后释放。</span>
                    </p>
                  </div>
                </section>
                {!collection.models.length && (
                  <div className="private-role-notice">
                    <CircleHelp size={17} />
                    <p>
                      当前没有可用的语言模型。你仍可保存角色草稿；管理员启用模型后，编辑角色并关联模型即可开始对话。
                    </p>
                  </div>
                )}
                <div className="toolbar">
                  <div className="search-box">
                    <Search size={17} />
                    <input
                      aria-label="搜索我的角色"
                      placeholder="搜索名称、简介或标签…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <Badge>{collection.items.length} 位角色</Badge>
                </div>
                {items.length ? (
                  <div className="private-character-grid">
                    {items.map((character) => {
                      const model = collection.models.find(
                        (entry) => entry.id === character.providerId,
                      );
                      const available = character.active && !!model;
                      return (
                        <article
                          key={character.id}
                          className="paper-card private-character-card"
                          style={{ '--character-color': character.color } as CSSProperties}
                        >
                          <div className="private-character-top">
                            <Avatar
                              name={character.name}
                              src={character.avatar}
                              color={character.color}
                              size="large"
                            />
                            <Badge
                              tone={available ? 'green' : character.active ? 'amber' : 'neutral'}
                            >
                              {available ? '可以对话' : character.active ? '模型不可用' : '未启用'}
                            </Badge>
                          </div>
                          <h2>{character.name}</h2>
                          <span className="private-character-privacy">
                            <LockKeyhole size={11} />
                            仅自己可见
                          </span>
                          <p className="private-character-description">
                            {character.description || '还没有填写简介，编辑角色时可以补充。'}
                          </p>
                          {!!character.tags.length && (
                            <div className="character-tags">
                              {character.tags.slice(0, 4).map((tag) => (
                                <Badge key={tag}>{tag}</Badge>
                              ))}
                              {character.tags.length > 4 && (
                                <Badge>+{character.tags.length - 4}</Badge>
                              )}
                            </div>
                          )}
                          <p className="private-character-model">
                            <Sparkles size={13} />
                            <span>
                              {model?.name ||
                                (character.providerId
                                  ? '原模型暂不可用，请重新选择'
                                  : '尚未关联语言模型')}
                            </span>
                          </p>
                          <div className="private-character-actions">
                            <Button
                              variant="secondary"
                              disabled={!available}
                              onClick={() => setSelected(character)}
                            >
                              <MessageCircle size={15} />
                              开始对话
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={`编辑角色 ${character.name}`}
                              onClick={() => setEditor({ item: character })}
                            >
                              <Pencil size={15} />
                              编辑
                            </Button>
                            <button
                              type="button"
                              className="icon-button private-character-delete"
                              aria-label={`删除角色 ${character.name}`}
                              onClick={() => setRemove(character)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="paper-card">
                    <EmptyState
                      icon={<Sparkles size={27} />}
                      title={query ? '没有找到匹配的角色' : '从一个名字，开始新的故事'}
                      description={
                        query
                          ? '试试其他名称或标签，或清除搜索条件。'
                          : canCreate
                            ? '写下角色的性格与背景。你创建的角色只有自己可以查看和使用。'
                            : '当前没有可用的角色槽位。你可以联系管理员调整，或先去角色广场认识平台角色。'
                      }
                      action={
                        query ? (
                          <Button variant="secondary" onClick={() => setQuery('')}>
                            清除搜索
                          </Button>
                        ) : canCreate ? (
                          <Button onClick={() => setEditor({})}>
                            <Plus size={16} />
                            创建第一个角色
                          </Button>
                        ) : (
                          <Link className="button button-secondary" href="/characters">
                            前往角色广场
                            <ArrowUpRight size={15} />
                          </Link>
                        )
                      }
                    />
                  </div>
                )}
                <p className="private-character-footnote">
                  <CircleHelp size={14} />
                  <span>
                    想设置你在故事中的身份？前往 <Link href="/persona">我的自设</Link> 编辑你的 RP
                    身份卡。
                  </span>
                </p>
              </>
            )
          )}
        </>
      )}
      {editor && collection && (
        <PrivateCharacterEditor
          item={editor.item}
          models={collection.models}
          onClose={() => setEditor(null)}
          onSaved={saved}
          onRefresh={load}
        />
      )}
      {remove && (
        <RemoveCharacter character={remove} onClose={() => setRemove(null)} onRemoved={removed} />
      )}
      {selected && (
        <NewChat open initialCharacter={selected.id} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function PrivateCharacterEditor({
  item,
  models,
  onClose,
  onSaved,
  onRefresh,
}: {
  item?: Character;
  models: CharacterCollection['models'];
  onClose: () => void;
  onSaved: (character: Character) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    name: item?.name ?? '',
    description: item?.description ?? '',
    personality: item?.personality ?? '',
    greeting: item?.greeting ?? '',
    avatar: item?.avatar ?? '',
    color: item?.color ?? '#cfddc3',
    providerId: item ? (item.providerId ?? '') : (models[0]?.id ?? ''),
    active: item?.active ?? models.length > 0,
  });
  const [tags, setTags] = useState(item?.tags.join('，') ?? '');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [avatarFilename, setAvatarFilename] = useState('');
  const [readingAvatar, setReadingAvatar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const avatarInput = useRef<HTMLInputElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  const errorNote = useRef<HTMLParagraphElement>(null);
  const persistedId = useRef(item?.id);
  const availableModel = models.some((model) => model.id === draft.providerId);
  const field = (key: keyof typeof draft, value: string | boolean) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const dismiss = () => {
    if (!busy && !readingAvatar) onClose();
  };
  useEffect(() => {
    if (error) errorNote.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  async function chooseAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy || readingAvatar) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('头像仅支持 JPG、PNG 或 WebP 图片。');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('头像原图不能超过 2 MiB，请选择较小的图片。');
      return;
    }
    setReadingAvatar(true);
    try {
      const value = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('无法读取图片，请重新选择。'));
        reader.readAsDataURL(file);
      });
      setAvatarDataUrl(value);
      setAvatarFilename(file.name);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setReadingAvatar(false);
      requestAnimationFrame(() => avatarButton.current?.focus({ preventScroll: true }));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || readingAvatar) return;
    setError('');
    const tagList = [
      ...new Set(
        tags
          .split(/[,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!draft.name.trim() || !draft.personality.trim()) {
      setError('请填写角色名称和角色人设。');
      return;
    }
    if (tagList.length > 10 || tagList.some((tag) => tag.length > 24)) {
      setError('最多添加 10 个标签，每个标签不超过 24 字。');
      return;
    }
    if (draft.active && !availableModel) {
      setError('启用角色前，请选择可用的语言模型；也可以关闭启用并保存为草稿。');
      return;
    }
    setBusy(true);
    try {
      const saved = await api<Character>(
        persistedId.current ? `/account/characters/${persistedId.current}` : '/account/characters',
        json(persistedId.current ? 'PATCH' : 'POST', {
          ...draft,
          name: draft.name.trim(),
          personality: draft.personality.trim(),
          tags: tagList,
          providerId: availableModel ? draft.providerId : null,
          ...(avatarDataUrl ? { avatarDataUrl } : {}),
        }),
      );
      persistedId.current = saved.id;
      setAvatarDataUrl(null);
      setAvatarFilename('');
      field('avatar', saved.avatar);
      await onSaved(saved);
    } catch (reason) {
      setError((reason as Error).message);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={dismiss}
      title={item ? '编辑我的角色' : '创建我的角色'}
      description="角色仅自己可见。保存后可用于你的私聊与群聊，不会发布到角色广场。"
    >
      <form className="private-character-form" onSubmit={submit} aria-busy={busy || readingAvatar}>
        {error && (
          <p className="form-error" role="alert" ref={errorNote}>
            {error}
          </p>
        )}
        <fieldset disabled={busy || readingAvatar}>
          <div className="private-avatar-editor">
            <Avatar
              name={draft.name || '角色'}
              color={draft.color}
              src={avatarDataUrl || draft.avatar}
              size="large"
            />
            <div>
              <strong>角色头像</strong>
              <p>
                {avatarFilename
                  ? `${avatarFilename} · 保存后生效`
                  : 'JPG、PNG 或 WebP，最大 2 MiB。保存时裁切为正方形。'}
              </p>
              <div className="private-avatar-actions">
                <Button
                  ref={avatarButton}
                  type="button"
                  variant="secondary"
                  loading={readingAvatar}
                  onClick={() => avatarInput.current?.click()}
                >
                  <Camera size={15} />
                  {avatarDataUrl || draft.avatar ? '更换图片' : '上传图片'}
                </Button>
                {(avatarDataUrl || draft.avatar) && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setAvatarDataUrl(null);
                      setAvatarFilename('');
                      field('avatar', '');
                    }}
                  >
                    <X size={14} />
                    移除头像
                  </Button>
                )}
              </div>
            </div>
            <input
              ref={avatarInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              tabIndex={-1}
              hidden
              aria-label="上传我的角色头像文件"
              onChange={(event) => void chooseAvatar(event)}
            />
          </div>
          <Field label="角色名称">
            <input
              required
              maxLength={60}
              value={draft.name}
              onChange={(event) => field('name', event.target.value)}
              placeholder="给这位朋友起一个名字"
            />
          </Field>
          <Field label="角色简介" hint="用于你的角色列表，最多 500 字。">
            <textarea
              rows={2}
              maxLength={500}
              value={draft.description}
              onChange={(event) => field('description', event.target.value)}
              placeholder="简单介绍角色的身份、性格或故事背景…"
            />
          </Field>
          <Field
            label="角色人设"
            hint={`${draft.personality.length.toLocaleString()} / 20,000 字。描述身份、性格、语气与互动方式。`}
          >
            <textarea
              required
              rows={6}
              maxLength={20000}
              value={draft.personality}
              onChange={(event) => field('personality', event.target.value)}
              placeholder="这个角色是谁？有哪些经历、兴趣和说话习惯？"
            />
          </Field>
          <Field label="开场白" hint="开启新私聊时展示的第一句话。">
            <textarea
              rows={3}
              maxLength={4000}
              value={draft.greeting}
              onChange={(event) => field('greeting', event.target.value)}
              placeholder="写下角色想对你说的第一句话…"
            />
          </Field>
          <div className="private-character-form-grid">
            <Field
              label="头像图片地址"
              hint={
                avatarDataUrl
                  ? '已选择上传图片，保存时将使用图片文件。'
                  : draft.avatar.startsWith('/api/avatars/')
                    ? '已使用上传的头像。填写新地址可以替换。'
                    : '可选，也支持 HTTP / HTTPS 图片地址。'
              }
            >
              <input
                type="url"
                pattern="https?://.*"
                maxLength={2048}
                disabled={!!avatarDataUrl}
                value={draft.avatar.startsWith('/api/avatars/') ? '' : draft.avatar}
                onChange={(event) => field('avatar', event.target.value)}
                placeholder="https://example.com/avatar.png"
              />
            </Field>
            <Field label="角色主题色">
              <div className="private-character-color">
                <input
                  type="color"
                  value={draft.color}
                  onChange={(event) => field('color', event.target.value)}
                />
                <span>{draft.color.toUpperCase()}</span>
              </div>
            </Field>
          </div>
          <Field label="角色标签" hint="用逗号分隔，最多 10 个，每个标签最多 24 字。">
            <input
              maxLength={300}
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="友善，冒险，日常"
            />
          </Field>
          <Field label="语言模型" hint="可选择管理员已启用的语言模型，调用使用你的账户额度。">
            <Select
              value={draft.providerId}
              onValueChange={(value) => {
                field('providerId', value);
                if (!value) field('active', false);
              }}
            >
              <option value="">暂不关联 · 保存为草稿</option>
              {draft.providerId && !availableModel && (
                <option value={draft.providerId} disabled>
                  原模型暂不可用，请重新选择
                </option>
              )}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </Select>
          </Field>
          <label className="toggle-row private-character-toggle">
            <span>
              启用此角色
              <small>
                {availableModel
                  ? '启用后可以开始对话；停用时保留资料，并继续占用槽位。'
                  : '请先选择可用的语言模型。当前可保存为未启用的草稿。'}
              </small>
            </span>
            <input
              type="checkbox"
              checked={draft.active}
              disabled={!availableModel && !draft.active}
              onChange={(event) => field('active', event.target.checked)}
            />
          </label>
        </fieldset>
        <div className="private-character-form-footer">
          <span>
            <LockKeyhole size={13} />
            仅自己可见
          </span>
          <div>
            <Button
              type="button"
              variant="ghost"
              disabled={busy || readingAvatar}
              onClick={dismiss}
            >
              取消
            </Button>
            <Button type="submit" loading={busy} disabled={readingAvatar}>
              <Check size={16} />
              {draft.active ? '保存角色' : '保存草稿'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function RemoveCharacter({
  character,
  onClose,
  onRemoved,
}: {
  character: Character;
  onClose: () => void;
  onRemoved: (character: Character) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/account/characters/${character.id}`, json('DELETE'));
      await onRemoved(character);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      title="删除我的角色"
      onClose={() => {
        if (!busy) onClose();
      }}
      description="删除角色会释放一个创建槽位。"
    >
      <div className="private-character-delete-note">
        <Avatar name={character.name} src={character.avatar} color={character.color} />
        <div>
          <strong>{character.name}</strong>
          <p>已有对话与记忆会保留；删除后，该角色将无法继续回复消息。此操作无法撤销。</p>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button variant="danger" loading={busy} onClick={() => void remove()}>
          <Trash2 size={15} />
          确认删除
        </Button>
      </div>
    </Modal>
  );
}
