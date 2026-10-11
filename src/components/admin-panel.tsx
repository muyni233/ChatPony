'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Building2,
  Camera,
  Check,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  FileSearch,
  FileText,
  Globe2,
  LayoutDashboard,
  Mail,
  MessageSquareText,
  Megaphone,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { api, json } from '@/lib/client';
import { Badge, Button, EmptyState, Field, Modal, Select } from '@/components/ui';
import { RequestAuditPanel } from '@/components/request-audit';
import { MailSettings } from '@/components/mail-settings';
import { DialogueSettings } from '@/components/dialogue-settings';
import type {
  AdminOverview,
  Announcement,
  Character,
  EmbeddingConfig,
  ModelCapability,
  ModelKind,
  PlatformSettings,
  Protocol,
  ProviderConfig,
  ReasoningEffort,
  SupplierConfig,
  User,
} from '@/lib/types';
import './admin.css';

type Tab =
  | 'overview'
  | 'characters'
  | 'providers'
  | 'dialogue'
  | 'announcements'
  | 'users'
  | 'requests'
  | 'mail'
  | 'settings';
type Editor =
  | { type: 'character'; item?: Character }
  | { type: 'supplier'; item?: SupplierConfig }
  | { type: 'provider'; item?: ProviderConfig; supplierId?: string }
  | { type: 'announcement'; item?: Announcement }
  | { type: 'user'; item: User }
  | null;
type AdminData = {
  overview: AdminOverview;
  characters: Character[];
  suppliers: SupplierConfig[];
  providers: ProviderConfig[];
  announcements: Announcement[];
  users: User[];
  settings: PlatformSettings;
  embeddings: EmbeddingConfig;
};
type Confirmation = {
  title: string;
  description: string;
  label: string;
  phrase?: string;
  action: () => Promise<unknown>;
  success: string;
} | null;

const protocolNames: Record<Protocol, string> = {
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  gemini: 'Gemini Native',
};
const supplierProtocolUrls: Record<Protocol, string> = {
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
const capabilityNames: Record<ModelCapability, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  file: '文件',
};
const effortNames: Record<ReasoningEffort, string> = {
  default: '模型默认',
  none: '关闭思考',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};
const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: '平台概览', icon: <LayoutDashboard size={16} /> },
  { id: 'characters', label: '角色管理', icon: <Sparkles size={16} /> },
  { id: 'providers', label: '供应商与模型', icon: <Cpu size={16} /> },
  { id: 'dialogue', label: '对话策略', icon: <MessageSquareText size={16} /> },
  { id: 'announcements', label: '公告管理', icon: <Megaphone size={16} /> },
  { id: 'users', label: '用户与限额', icon: <Users size={16} /> },
  { id: 'requests', label: '请求审查', icon: <FileSearch size={16} /> },
  { id: 'mail', label: '邮件验证', icon: <Mail size={16} /> },
  { id: 'settings', label: '平台设置', icon: <Settings2 size={16} /> },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}
function amount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}
function host(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
function modelAvailable(model: ProviderConfig): boolean {
  return model.active && model.supplierActive !== false;
}
function languageModelAvailable(model: ProviderConfig): boolean {
  return model.kind === 'language' && modelAvailable(model);
}

function ErrorNote({ error }: { error: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error)
      ref.current?.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
  }, [error]);
  return error ? (
    <div ref={ref} className="admin-error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="admin-toggle-row">
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        className="admin-toggle"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="admin-toggle-track" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}
function FormFooter({
  pending,
  onClose,
  label = '保存更改',
}: {
  pending: boolean;
  onClose: () => void;
  label?: string;
}) {
  return (
    <div className="admin-form-footer">
      <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
        取消
      </Button>
      <Button type="submit" loading={pending}>
        <Check size={16} />
        {label}
      </Button>
    </div>
  );
}
function SectionTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="admin-section-title">
      <div>
        <span className="admin-eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function AdminPanel() {
  const { data: app, refresh, notify } = useApp();
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [userFilter, setUserFilter] = useState('all');
  const authorized = app?.user?.role === 'admin';

  const load = useCallback(async () => {
    if (!authorized) return;
    setLoading(true);
    setError('');
    try {
      const [
        overview,
        characters,
        suppliers,
        providers,
        announcements,
        users,
        settings,
        embeddings,
      ] = await Promise.all([
        api<AdminOverview>('/api/admin/overview'),
        api<Character[]>('/api/admin/characters'),
        api<SupplierConfig[]>('/api/admin/suppliers'),
        api<ProviderConfig[]>('/api/admin/models'),
        api<Announcement[]>('/api/admin/announcements'),
        api<User[]>('/api/admin/users'),
        api<PlatformSettings>('/api/admin/settings'),
        api<EmbeddingConfig>('/api/admin/embeddings'),
      ]);
      setData({
        overview,
        characters,
        suppliers,
        providers,
        announcements,
        users,
        settings,
        embeddings,
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [authorized]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saved(message: string) {
    await Promise.all([load(), refresh()]);
    setEditor((current) => (current === editor ? null : current));
    notify(message, 'success');
  }

  function confirmDelete(
    type: 'characters' | 'models' | 'suppliers' | 'announcements',
    id: string,
    name: string,
  ) {
    const kind = {
      characters: '角色',
      models: '模型配置',
      suppliers: '供应商',
      announcements: '公告',
    }[type];
    const detail = {
      characters: '该角色将从可选角色列表中移除。',
      models: '删除后，关联此模型配置的角色会一并下架。已有对话历史会保留。',
      suppliers: `该供应商下的 ${data?.providers.filter((model) => model.supplierId === id).length ?? 0} 个模型配置将同时归档，关联角色将下架。已有对话历史会保留。`,
      announcements: '该公告及其正文将被永久删除。',
    }[type];
    setConfirmation({
      title: `删除${kind}`,
      description: `即将删除「${name}」。${detail}`,
      label: `删除${kind}`,
      action: () => api(`/api/admin/${type}/${id}`, json('DELETE', {})),
      success: `${kind}已删除`,
    });
  }

  function resetQuota(user?: User) {
    setConfirmation({
      title: user ? '重置用户限额' : '重置全员限额',
      description: user
        ? `即将清空 ${user.name}（${user.email}）在 5 小时和 7 天两个周期内的调用计数，配置的限额上限保持不变。`
        : `即将清空全部 ${data?.users.length ?? 0} 位用户在 5 小时和 7 天两个周期内的调用计数。此操作会立即恢复所有用户的可用额度。`,
      label: user ? '确认重置' : '重置全员限额',
      phrase: user ? undefined : '重置全部',
      action: () => api('/api/admin/quotas/reset', json('POST', user ? { userId: user.id } : {})),
      success: user ? `${user.name} 的限额已重置` : '全员限额已重置',
    });
  }

  async function testProvider(provider: ProviderConfig) {
    setTesting(provider.id);
    try {
      const result = await api<{ ok: boolean; message: string }>(
        `/api/admin/models/${provider.id}/test`,
        json('POST', {}),
      );
      notify(result.message || '模型连接测试成功', result.ok ? 'success' : 'error');
    } catch (reason) {
      notify(errorMessage(reason), 'error');
    } finally {
      setTesting(null);
    }
  }

  const filteredUsers = useMemo(
    () =>
      data?.users.filter(
        (user) =>
          `${user.name} ${user.email}`.toLowerCase().includes(search.trim().toLowerCase()) &&
          (userFilter === 'all' ||
            (userFilter === 'admin' && user.role === 'admin') ||
            (userFilter === 'disabled' && user.disabled)),
      ) ?? [],
    [data?.users, search, userFilter],
  );

  if (!app)
    return (
      <div className="admin-loading" role="status">
        <RefreshCw className="admin-spin" size={24} />
        <p>正在加载管理控制台…</p>
      </div>
    );
  if (!authorized)
    return (
      <div className="admin-access">
        <EmptyState
          icon={<ShieldCheck size={30} />}
          title="需要管理员权限"
          description="请使用管理员账户登录后访问平台控制台。"
        />
      </div>
    );

  return (
    <div className="admin-page">
      <header className="admin-page-header">
        <div>
          <span className="admin-eyebrow">
            <span className="admin-status-dot" /> CHATPONY ADMIN
          </span>
          <h1>
            管理控制台<span className="admin-title-dot">.</span>
          </h1>
          <p>统一管理角色、模型、用户与平台配置。</p>
        </div>
        <div className="admin-admin-mark">
          <ShieldCheck size={19} />
          <span>
            管理员控制台<small>仅管理员可见</small>
          </span>
        </div>
      </header>
      <nav className="admin-tabs" aria-label="管理控制台导航">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`admin-tab ${tab === item.id ? 'is-active' : ''}`}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.id === 'characters' && !!data?.characters.length && (
              <span className="admin-tab-count">{data.characters.length}</span>
            )}
          </button>
        ))}
      </nav>
      {error && (
        <div className="admin-load-error">
          <ErrorNote error={error} />
          <Button variant="secondary" onClick={() => void load()} loading={loading}>
            重新加载
          </Button>
        </div>
      )}
      {!data && loading && (
        <div className="admin-skeleton" role="status" aria-label="正在加载平台数据">
          <div />
          <div />
          <div />
          <div />
          <span />
          <span />
        </div>
      )}
      {data && (
        <div key={tab} className="admin-view">
          {tab === 'overview' && (
            <>
              <div className="admin-overview-heading">
                <span className="admin-eyebrow">THE BIG PICTURE</span>
                <Button variant="ghost" onClick={() => void load()} loading={loading}>
                  <RefreshCw size={15} />
                  刷新数据
                </Button>
              </div>
              <div className="admin-stats">
                {[
                  {
                    label: '注册用户',
                    value: data.overview.users,
                    caption: '公开注册与管理员账户',
                    icon: <Users size={20} />,
                    tone: 'green',
                  },
                  {
                    label: '平台角色',
                    value: data.overview.characters,
                    caption: `${data.characters.filter((item) => item.active && data.providers.some((provider) => provider.id === item.providerId && languageModelAvailable(provider))).length} 个角色已上架`,
                    icon: <Sparkles size={20} />,
                    tone: 'pink',
                  },
                  {
                    label: '累计对话',
                    value: data.overview.conversations,
                    caption: '包含单角色私聊与群聊',
                    icon: <BookOpen size={20} />,
                    tone: 'yellow',
                  },
                  {
                    label: '模型调用',
                    value: data.overview.calls,
                    caption: '已成功完成的模型响应',
                    icon: <Activity size={20} />,
                    tone: 'blue',
                  },
                ].map((stat, index) => (
                  <article className={`admin-stat admin-stat-${stat.tone}`} key={stat.label}>
                    <div className="admin-stat-top">
                      <span>{stat.label}</span>
                      {stat.icon}
                    </div>
                    <strong>{amount(stat.value)}</strong>
                    <div className="admin-stat-bottom">
                      <small>{stat.caption}</small>
                      <span>0{index + 1}</span>
                    </div>
                  </article>
                ))}
              </div>
              <div className="admin-overview-grid">
                <section className="admin-paper admin-setup">
                  <div className="admin-card-heading">
                    <div>
                      <span className="admin-eyebrow">READY, SET, CONNECT</span>
                      <h3>平台配置清单</h3>
                    </div>
                    <span className="admin-stamp">
                      <Check size={13} />
                      WORKSPACE
                    </span>
                  </div>
                  <p className="admin-section-note">完成基础配置后，用户即可开始与角色对话。</p>
                  {[
                    {
                      title: '配置供应商与模型',
                      description: '添加供应商，并配置可用的对话模型',
                      complete: data.providers.some(languageModelAvailable),
                      tab: 'providers' as Tab,
                      icon: <Cpu size={20} />,
                    },
                    {
                      title: '创建你的第一个角色',
                      description: '设定人设，关联模型，再发布角色',
                      complete: data.characters.some(
                        (item) =>
                          item.active &&
                          data.providers.some(
                            (provider) =>
                              provider.id === item.providerId && languageModelAvailable(provider),
                          ),
                      ),
                      tab: 'characters' as Tab,
                      icon: <Sparkles size={20} />,
                    },
                    {
                      title: '发布社区公告',
                      description: '让用户了解平台动态与使用说明',
                      complete: data.announcements.some((item) => item.published),
                      tab: 'announcements' as Tab,
                      icon: <Megaphone size={20} />,
                    },
                  ].map((item) => (
                    <button
                      className="admin-setup-row"
                      key={item.title}
                      onClick={() => setTab(item.tab)}
                    >
                      <span className={`admin-setup-icon ${item.complete ? 'is-complete' : ''}`}>
                        {item.complete ? <Check size={20} /> : item.icon}
                      </span>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.description}</small>
                      </span>
                      <span className="admin-setup-state">
                        {item.complete ? '已完成' : '去配置'}
                        <ChevronRight size={15} />
                      </span>
                    </button>
                  ))}
                </section>
                <section className="admin-policy">
                  <div className="admin-paperclip" aria-hidden="true" />
                  <span className="admin-eyebrow">PLATFORM RULES</span>
                  <h3>调用与响应规则</h3>
                  <p>
                    查看全体用户的统一调用限额，
                    <br />
                    以及群聊的响应轮数上限。
                  </p>
                  <dl>
                    <div>
                      <dt>全局 · 5 小时限额</dt>
                      <dd>
                        {amount(data.settings.defaultLimit5h)}
                        <small> 次</small>
                      </dd>
                    </div>
                    <div>
                      <dt>全局 · 7 天限额</dt>
                      <dd>
                        {amount(data.settings.defaultLimit7d)}
                        <small> 次</small>
                      </dd>
                    </div>
                    <div>
                      <dt>群聊最大响应轮数</dt>
                      <dd>
                        {data.settings.maxGroupRounds}
                        <small> 轮</small>
                      </dd>
                    </div>
                  </dl>
                  <button onClick={() => setTab('settings')} className="admin-text-link">
                    调整平台设置 <ArrowUpRight size={16} />
                  </button>
                </section>
              </div>
              <div className="admin-overview-grid admin-overview-bottom">
                <section className="admin-paper">
                  <div className="admin-card-heading">
                    <h3>最近加入</h3>
                    <button onClick={() => setTab('users')} className="admin-text-link">
                      全部用户 <ArrowRight size={14} />
                    </button>
                  </div>
                  {data.users.length ? (
                    <div className="admin-recent-users">
                      {[...data.users]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .slice(0, 4)
                        .map((user) => (
                          <div key={user.id} className="admin-recent-user">
                            <span className="admin-user-avatar">{user.name.slice(0, 1)}</span>
                            <span>
                              <strong>{user.name}</strong>
                              <small>{user.email}</small>
                            </span>
                            <time dateTime={user.createdAt}>{dateLabel(user.createdAt)}</time>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="admin-inline-empty">目前还没有注册用户。</p>
                  )}
                </section>
                <section className="admin-paper">
                  <div className="admin-card-heading">
                    <h3>发布状态</h3>
                    <Megaphone size={18} />
                  </div>
                  <div className="admin-publication">
                    <strong>
                      {data.announcements.filter((item) => item.published).length}
                      <span>篇公告已发布</span>
                    </strong>
                    <p>
                      {data.announcements.filter((item) => !item.published).length} 篇草稿等待发布
                    </p>
                  </div>
                  <button className="admin-text-link" onClick={() => setTab('announcements')}>
                    管理平台公告 <ArrowRight size={14} />
                  </button>
                </section>
              </div>
            </>
          )}

          {tab === 'characters' && (
            <>
              <SectionTitle
                eyebrow="CHARACTER LIBRARY"
                title="角色管理"
                description="统一管理角色的人设、开场白与模型。上架后，用户即可开启对话。"
                action={
                  <Button onClick={() => setEditor({ type: 'character' })}>
                    <Plus size={17} />
                    创建角色
                  </Button>
                }
              />
              {!data.characters.length ? (
                <div className="admin-empty-paper">
                  <EmptyState
                    icon={<Sparkles size={28} />}
                    title="尚未创建角色"
                    description="平台不会预置角色。先连接模型，再为你的社区创建第一个角色。"
                    action={
                      <Button onClick={() => setEditor({ type: 'character' })}>
                        <Plus size={16} />
                        创建第一个角色
                      </Button>
                    }
                  />
                </div>
              ) : (
                <div className="admin-character-grid">
                  {data.characters.map((character) => {
                    const provider = data.providers.find(
                      (item) => item.id === character.providerId,
                    );
                    return (
                      <article
                        className="admin-character-card"
                        key={character.id}
                        style={{ '--character-color': character.color } as CSSProperties}
                      >
                        <div className="admin-character-card-top">
                          <span className="admin-character-avatar">
                            <span>{character.name.slice(0, 1)}</span>
                            {character.avatar && (
                              <img
                                key={character.avatar}
                                src={character.avatar}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                onError={(event) => {
                                  event.currentTarget.style.display = 'none';
                                }}
                              />
                            )}
                          </span>
                          <Badge
                            tone={
                              character.active && provider && languageModelAvailable(provider)
                                ? 'green'
                                : character.active
                                  ? 'amber'
                                  : 'neutral'
                            }
                          >
                            {character.active && provider && languageModelAvailable(provider)
                              ? '已上架'
                              : character.active
                                ? '暂不可用'
                                : '未上架'}
                          </Badge>
                        </div>
                        <h3>{character.name}</h3>
                        <span className="admin-character-slug">@{character.slug}</span>
                        <p className="admin-character-description">
                          {character.description || '尚未填写角色简介'}
                        </p>
                        <div className="admin-character-tags">
                          {character.tags.slice(0, 4).map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                        <div
                          className={`admin-character-model ${!provider || !modelAvailable(provider) ? 'is-missing' : ''}`}
                        >
                          <Cpu size={14} />
                          <span>
                            {provider
                              ? `${provider.name}${!modelAvailable(provider) ? ' · 暂不可用' : ''}`
                              : '尚未关联模型'}
                          </span>
                        </div>
                        <footer>
                          <Button
                            variant="ghost"
                            onClick={() => setEditor({ type: 'character', item: character })}
                          >
                            <Pencil size={14} />
                            编辑角色
                          </Button>
                          <button
                            className="admin-icon-button admin-danger-icon"
                            aria-label={`删除角色 ${character.name}`}
                            onClick={() =>
                              confirmDelete('characters', character.id, character.name)
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'providers' && (
            <>
              <SectionTitle
                eyebrow="SUPPLIERS & MODELS"
                title="供应商与模型"
                description="供应商统一维护 API 协议、服务地址与密钥，每个供应商下可配置多个模型。"
                action={
                  <Button onClick={() => setEditor({ type: 'supplier' })}>
                    <Plus size={17} />
                    添加供应商
                  </Button>
                }
              />
              <div className="admin-protocol-strip">
                {Object.entries(protocolNames).map(([key, name]) => (
                  <span key={key}>
                    <span className="admin-protocol-dot" />
                    {name}
                  </span>
                ))}
              </div>
              {!data.suppliers.length ? (
                <div className="admin-empty-paper">
                  <EmptyState
                    icon={<Building2 size={29} />}
                    title="添加第一个供应商"
                    description="先配置供应商的协议、服务地址与 API 密钥，再添加模型并关联角色。"
                    action={
                      <Button onClick={() => setEditor({ type: 'supplier' })}>
                        <Plus size={16} />
                        添加供应商
                      </Button>
                    }
                  />
                </div>
              ) : (
                <div className="admin-supplier-list">
                  {data.suppliers.map((supplier) => {
                    const models = data.providers.filter(
                      (model) => model.supplierId === supplier.id,
                    );
                    return (
                      <section
                        className="admin-supplier-card"
                        key={supplier.id}
                        aria-label={`供应商 ${supplier.name}`}
                      >
                        <header className="admin-supplier-heading">
                          <span className="admin-supplier-icon">
                            <Building2 size={23} strokeWidth={1.5} />
                          </span>
                          <div className="admin-supplier-info">
                            <div className="admin-supplier-name">
                              <h3>{supplier.name}</h3>
                              <Badge tone={supplier.active ? 'green' : 'neutral'}>
                                {supplier.active ? '已启用' : '已停用'}
                              </Badge>
                              <span className="admin-supplier-count">{models.length} 个模型</span>
                            </div>
                            <div className="admin-supplier-meta">
                              <span>
                                <Cpu size={12} />
                                {protocolNames[supplier.protocol]}
                              </span>
                              <span title={supplier.baseUrl}>
                                <Globe2 size={12} />
                                {supplier.baseUrl}
                              </span>
                              <span>
                                <ShieldCheck size={12} />
                                {supplier.hasKey ? '密钥已配置' : '未设置密钥'}
                              </span>
                            </div>
                          </div>
                          <div className="admin-supplier-actions">
                            <Button
                              variant="secondary"
                              onClick={() =>
                                setEditor({ type: 'provider', supplierId: supplier.id })
                              }
                            >
                              <Plus size={15} />
                              添加模型
                            </Button>
                            <button
                              className="admin-icon-button"
                              aria-label={`编辑供应商 ${supplier.name}`}
                              onClick={() => setEditor({ type: 'supplier', item: supplier })}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              className="admin-icon-button admin-danger-icon"
                              aria-label={`删除供应商 ${supplier.name}`}
                              onClick={() => confirmDelete('suppliers', supplier.id, supplier.name)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </header>
                        {!supplier.active && models.length > 0 && (
                          <div className="admin-supplier-disabled">
                            <AlertCircle size={14} />
                            供应商已停用，其下模型与关联角色暂不可用。
                          </div>
                        )}
                        <div className="admin-supplier-models">
                          {models.length ? (
                            models.map((model) => (
                              <article
                                key={model.id}
                                className="admin-provider-card admin-model-row"
                              >
                                <div className="admin-provider-main">
                                  <span className="admin-model-icon">
                                    <Cpu size={20} strokeWidth={1.5} />
                                  </span>
                                  <div>
                                    <div className="admin-provider-name">
                                      <h4>{model.name}</h4>
                                      <Badge
                                        tone={
                                          modelAvailable(model)
                                            ? 'green'
                                            : model.active
                                              ? 'amber'
                                              : 'neutral'
                                        }
                                      >
                                        {modelAvailable(model)
                                          ? '已启用'
                                          : model.active
                                            ? '供应商停用'
                                            : '已停用'}
                                      </Badge>
                                    </div>
                                    <span className="admin-provider-model">{model.model}</span>
                                    <div className="admin-provider-protocol">
                                      <Badge tone={model.kind === 'embedding' ? 'pink' : 'neutral'}>
                                        {model.kind === 'embedding' ? '向量模型' : '语言模型'}
                                      </Badge>
                                      {model.kind === 'language' && (
                                        <span>
                                          {model.capabilities
                                            .map((capability) => capabilityNames[capability])
                                            .join(' / ')}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="admin-provider-details">
                                  {model.kind === 'language' ? (
                                    <>
                                      <div>
                                        <small>上下文窗口</small>
                                        <strong>{amount(model.contextWindow)}</strong>
                                      </div>
                                      <div>
                                        <small>输出上限</small>
                                        <strong>{amount(model.maxOutput)}</strong>
                                      </div>
                                      <div>
                                        <small>思考设置</small>
                                        <strong>
                                          {model.thinkingBudget !== null
                                            ? `${amount(model.thinkingBudget)} tokens`
                                            : effortNames[model.reasoningEffort]}
                                        </strong>
                                      </div>
                                    </>
                                  ) : (
                                    <div>
                                      <small>用途</small>
                                      <strong>语义检索</strong>
                                    </div>
                                  )}
                                </div>
                                <div className="admin-provider-actions">
                                  <Button
                                    variant="secondary"
                                    loading={testing === model.id}
                                    disabled={
                                      !modelAvailable(model) ||
                                      (testing !== null && testing !== model.id)
                                    }
                                    onClick={() => void testProvider(model)}
                                  >
                                    <Activity size={15} />
                                    连接测试
                                  </Button>
                                  <button
                                    className="admin-icon-button"
                                    aria-label={`编辑模型 ${model.name}`}
                                    onClick={() => setEditor({ type: 'provider', item: model })}
                                  >
                                    <Pencil size={16} />
                                  </button>
                                  <button
                                    className="admin-icon-button admin-danger-icon"
                                    aria-label={`删除模型 ${model.name}`}
                                    onClick={() => confirmDelete('models', model.id, model.name)}
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </article>
                            ))
                          ) : (
                            <div className="admin-supplier-empty">
                              <Cpu size={19} />
                              <div>
                                <strong>此供应商下还没有模型</strong>
                                <p>添加模型 ID、协议与生成参数，即可供角色选择。</p>
                              </div>
                              <button
                                type="button"
                                className="admin-text-link"
                                onClick={() =>
                                  setEditor({ type: 'provider', supplierId: supplier.id })
                                }
                              >
                                添加模型 <ArrowRight size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
              <div className="admin-info-line">
                <ShieldCheck size={16} />
                <p>
                  同一供应商下的模型共用服务地址、认证密钥和 API 协议。
                  密钥在服务端加密保存；连接测试会发起真实的模型请求。
                </p>
              </div>
              <EmbeddingEditor
                config={data.embeddings}
                models={data.providers}
                onSaved={() => saved('向量记忆配置已保存')}
              />
            </>
          )}

          {tab === 'announcements' && (
            <>
              <SectionTitle
                eyebrow="COMMUNITY NOTICEBOARD"
                title="公告管理"
                description="发布平台动态、使用说明或维护通知。重要公告可以置顶展示。"
                action={
                  <Button onClick={() => setEditor({ type: 'announcement' })}>
                    <Plus size={17} />
                    撰写公告
                  </Button>
                }
              />
              {!data.announcements.length ? (
                <div className="admin-empty-paper">
                  <EmptyState
                    icon={<Megaphone size={28} />}
                    title="尚未发布公告"
                    description="写一则欢迎公告，或向大家介绍平台的使用方式。"
                    action={
                      <Button onClick={() => setEditor({ type: 'announcement' })}>
                        <Pencil size={16} />
                        撰写第一则公告
                      </Button>
                    }
                  />
                </div>
              ) : (
                <div className="admin-announcement-list">
                  {[...data.announcements]
                    .sort(
                      (a, b) =>
                        Number(b.pinned) - Number(a.pinned) ||
                        b.createdAt.localeCompare(a.createdAt),
                    )
                    .map((announcement) => (
                      <article className="admin-announcement-card" key={announcement.id}>
                        <div
                          className={`admin-announcement-icon ${announcement.pinned ? 'is-pinned' : ''}`}
                        >
                          {announcement.pinned ? <Pin size={22} /> : <FileText size={22} />}
                        </div>
                        <div className="admin-announcement-body">
                          <div className="admin-announcement-meta">
                            <Badge tone={announcement.published ? 'green' : 'neutral'}>
                              {announcement.published ? '已发布' : '草稿'}
                            </Badge>
                            {announcement.pinned && (
                              <span className="admin-pinned-label">置顶</span>
                            )}
                            <time dateTime={announcement.updatedAt}>
                              {dateLabel(announcement.updatedAt)}
                            </time>
                          </div>
                          <h3>{announcement.title}</h3>
                          <p>{announcement.content}</p>
                        </div>
                        <div className="admin-announcement-actions">
                          <Button
                            variant="ghost"
                            onClick={() => setEditor({ type: 'announcement', item: announcement })}
                          >
                            <Pencil size={15} />
                            编辑
                          </Button>
                          <button
                            className="admin-icon-button admin-danger-icon"
                            aria-label={`删除公告 ${announcement.title}`}
                            onClick={() =>
                              confirmDelete('announcements', announcement.id, announcement.title)
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              )}
            </>
          )}

          {tab === 'users' && (
            <>
              <SectionTitle
                eyebrow="PEOPLE & PERMISSIONS"
                title="用户与调用限额"
                description="管理账户权限、调用限额与私有角色槽位。5 小时、7 天两种滚动限额会同时生效。"
                action={
                  <Button variant="secondary" onClick={() => resetQuota()}>
                    <RefreshCw size={16} />
                    重置全员限额
                  </Button>
                }
              />
              <div className="admin-user-toolbar">
                <label className="admin-search">
                  <Search size={17} />
                  <input
                    placeholder="搜索用户名或邮箱…"
                    aria-label="搜索用户"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {search && (
                    <button aria-label="清除搜索" onClick={() => setSearch('')}>
                      <X size={14} />
                    </button>
                  )}
                </label>
                <Select
                  aria-label="筛选用户"
                  className="admin-filter"
                  value={userFilter}
                  onValueChange={(value) => setUserFilter(value)}
                >
                  <option value="all">全部用户</option>
                  <option value="admin">管理员</option>
                  <option value="disabled">已停用账户</option>
                </Select>
                <span className="admin-result-count">{filteredUsers.length} 位用户</span>
              </div>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>权限 / 状态</th>
                      <th>5 小时限额</th>
                      <th>7 天限额</th>
                      <th>角色槽位</th>
                      <th>加入时间</th>
                      <th>
                        <span className="admin-sr-only">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <div className="admin-table-user">
                            <span className="admin-user-avatar">{user.name.slice(0, 1)}</span>
                            <span>
                              <strong>
                                {user.name}
                                {user.id === app.user?.id && (
                                  <small className="admin-self-label">你</small>
                                )}
                              </strong>
                              <small>{user.email}</small>
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="admin-user-badges">
                            <Badge tone={user.role === 'admin' ? 'pink' : 'neutral'}>
                              {user.role === 'admin' ? '管理员' : '用户'}
                            </Badge>
                            {user.disabled && <Badge tone="amber">已停用</Badge>}
                          </div>
                        </td>
                        <td className="admin-table-number">
                          {amount(user.limit5h)}
                          <small> 次</small>
                        </td>
                        <td className="admin-table-number">
                          {amount(user.limit7d)}
                          <small> 次</small>
                        </td>
                        <td className="admin-table-number">
                          {amount(user.characterSlots ?? 3)}
                          <small> 个</small>
                        </td>
                        <td className="admin-table-date">{dateLabel(user.createdAt)}</td>
                        <td>
                          <div className="admin-table-actions">
                            <button
                              className="admin-icon-button"
                              aria-label={`修改 ${user.name} 的权限、限额与槽位`}
                              onClick={() => setEditor({ type: 'user', item: user })}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              className="admin-icon-button"
                              aria-label={`重置 ${user.name} 的限额`}
                              onClick={() => resetQuota(user)}
                            >
                              <RefreshCw size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filteredUsers.length && (
                  <div className="admin-table-empty">
                    <Search size={24} />
                    <strong>没有找到匹配的用户</strong>
                    <p>试试其他用户名、邮箱或筛选条件。</p>
                  </div>
                )}
              </div>
              <div className="admin-info-line">
                <Clock3 size={16} />
                <p>
                  每次成功的角色响应计为一次调用，群聊按每个角色响应分别计数。设为 0
                  即不分配调用额度。
                </p>
              </div>
            </>
          )}

          {tab === 'dialogue' && (
            <DialogueSettings
              settings={data.settings}
              models={data.providers}
              onChanged={async () => {
                await Promise.all([load(), refresh()]);
              }}
            />
          )}
          {tab === 'requests' && (
            <RequestAuditPanel
              users={data.users}
              suppliers={data.suppliers}
              models={data.providers}
              captureEnabled={data.settings.auditCaptureContent}
              retentionDays={data.settings.auditRetentionDays}
              onOpenSettings={() => setTab('settings')}
            />
          )}
          {tab === 'mail' && (
            <MailSettings
              settings={data.settings}
              onChanged={async () => {
                await Promise.all([load(), refresh()]);
              }}
              onOpenSettings={() => setTab('settings')}
            />
          )}
          {tab === 'settings' && (
            <SettingsEditor settings={data.settings} onSaved={() => saved('平台设置已保存')} />
          )}
        </div>
      )}

      <Modal
        open={editor?.type === 'character'}
        onClose={() => setEditor(null)}
        title={editor?.type === 'character' && editor.item ? '编辑角色' : '创建角色'}
        description="设定角色的声音、个性与对话方式。"
        wide
      >
        {editor?.type === 'character' && (
          <CharacterEditor
            item={editor.item}
            providers={(data?.providers ?? []).filter((model) => model.kind === 'language')}
            onClose={() => setEditor(null)}
            onSaved={() => saved(editor.item ? '角色已更新' : '角色已创建')}
          />
        )}
      </Modal>
      <Modal
        open={editor?.type === 'supplier'}
        onClose={() => setEditor(null)}
        title={editor?.type === 'supplier' && editor.item ? '编辑供应商' : '添加供应商'}
        description="API 协议、服务地址和密钥由该供应商下的所有模型共用。"
      >
        {editor?.type === 'supplier' && (
          <SupplierEditor
            item={editor.item}
            onClose={() => setEditor(null)}
            onSaved={() => saved(editor.item ? '供应商已更新' : '供应商已添加')}
          />
        )}
      </Modal>
      <Modal
        open={editor?.type === 'provider'}
        onClose={() => setEditor(null)}
        title={editor?.type === 'provider' && editor.item ? '编辑模型配置' : '添加模型配置'}
        description="选择供应商并填写模型 ID 与生成参数，协议、地址和密钥由供应商统一管理。"
        wide
      >
        {editor?.type === 'provider' && (
          <ProviderEditor
            item={editor.item}
            supplierId={editor.supplierId}
            suppliers={data?.suppliers ?? []}
            onClose={() => setEditor(null)}
            onSaved={() => saved(editor.item ? '模型配置已更新' : '模型配置已添加')}
          />
        )}
      </Modal>
      <Modal
        open={editor?.type === 'announcement'}
        onClose={() => setEditor(null)}
        title={editor?.type === 'announcement' && editor.item ? '编辑公告' : '撰写公告'}
        description="正文将以保留换行的纯文本展示给用户。"
        wide
      >
        {editor?.type === 'announcement' && (
          <AnnouncementEditor
            item={editor.item}
            onClose={() => setEditor(null)}
            onSaved={() => saved(editor.item ? '公告已更新' : '公告已创建')}
          />
        )}
      </Modal>
      <Modal
        open={editor?.type === 'user'}
        onClose={() => setEditor(null)}
        title="权限、调用限额与角色槽位"
        description={editor?.type === 'user' ? `${editor.item.name} · ${editor.item.email}` : ''}
      >
        {editor?.type === 'user' && (
          <UserEditor
            item={editor.item}
            isSelf={editor.item.id === app.user?.id}
            onClose={() => setEditor(null)}
            onSaved={() => saved('用户设置已更新')}
          />
        )}
      </Modal>
      <Modal
        open={!!confirmation}
        onClose={() => setConfirmation(null)}
        title={confirmation?.title ?? '确认操作'}
      >
        {confirmation && (
          <ConfirmAction
            confirmation={confirmation}
            onClose={() => setConfirmation(null)}
            onDone={async () => {
              await Promise.all([load(), refresh()]);
              setConfirmation((current) => (current === confirmation ? null : current));
              notify(confirmation.success, 'success');
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function CharacterEditor({
  item,
  providers,
  onClose,
  onSaved,
}: {
  item?: Character;
  providers: ProviderConfig[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    name: item?.name ?? '',
    slug: item?.slug ?? '',
    description: item?.description ?? '',
    personality: item?.personality ?? '',
    greeting: item?.greeting ?? '',
    avatar: item?.avatar ?? '',
    color: item?.color ?? '#c0cdae',
    providerId: providers.some((provider) => provider.id === item?.providerId)
      ? (item?.providerId ?? '')
      : '',
    active: item?.active ?? false,
  });
  const [tags, setTags] = useState(item?.tags.join('，') ?? '');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [avatarFilename, setAvatarFilename] = useState('');
  const [readingAvatar, setReadingAvatar] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const persistedId = useRef(item?.id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const field = (key: keyof typeof draft, value: string | boolean) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  async function selectAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || pending || readingAvatar) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('角色头像仅支持 JPG、PNG 或 WebP 图片。');
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
      setError(errorMessage(reason));
    } finally {
      setReadingAvatar(false);
    }
  }
  function clearAvatar() {
    setAvatarDataUrl(null);
    setAvatarFilename('');
    field('avatar', '');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || readingAvatar) return;
    setError('');
    const tagList = [
      ...new Set(
        tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (tagList.length > 10 || tagList.some((tag) => tag.length > 24)) {
      setError('最多添加 10 个标签，每个标签不超过 24 字。');
      return;
    }
    if (
      draft.active &&
      !providers.some((provider) => provider.id === draft.providerId && modelAvailable(provider))
    ) {
      setError('上架前，请关联一个已启用的模型配置。');
      return;
    }
    if (!draft.personality.trim()) {
      setError('请填写角色人设。');
      return;
    }
    setPending(true);
    try {
      const saved = await api<Character>(
        persistedId.current
          ? `/api/admin/characters/${persistedId.current}`
          : '/api/admin/characters',
        json(persistedId.current ? 'PATCH' : 'POST', {
          ...draft,
          name: draft.name.trim(),
          slug: draft.slug.trim(),
          personality: draft.personality.trim(),
          tags: tagList,
          providerId: draft.providerId || null,
          ...(avatarDataUrl ? { avatarDataUrl } : {}),
        }),
      );
      persistedId.current = saved.id;
      setAvatarDataUrl(null);
      setAvatarFilename('');
      field('avatar', saved.avatar);
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="admin-form" onSubmit={submit} aria-busy={pending || readingAvatar}>
      <ErrorNote error={error} />
      <div className="admin-character-avatar-editor">
        <span className="admin-avatar-preview" style={{ backgroundColor: draft.color }}>
          <span>{draft.name.slice(0, 1) || <Camera size={27} />}</span>
          {(avatarDataUrl || draft.avatar) && (
            <img
              key={avatarDataUrl || draft.avatar}
              src={avatarDataUrl || draft.avatar}
              alt="角色头像预览"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          )}
        </span>
        <div className="admin-avatar-editor-content">
          <strong>角色头像</strong>
          <p>
            {avatarFilename
              ? `${avatarFilename} · 保存角色后生效`
              : '支持 JPG、PNG、WebP，最大 2 MiB。上传后自动裁切为正方形。'}
          </p>
          <div className="admin-avatar-editor-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              loading={readingAvatar}
              onClick={() => avatarInput.current?.click()}
            >
              <Camera size={16} />
              {avatarDataUrl || draft.avatar ? '更换图片' : '上传图片'}
            </Button>
            {(avatarDataUrl || draft.avatar) && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending || readingAvatar}
                onClick={clearAvatar}
              >
                <X size={15} />
                移除头像
              </Button>
            )}
          </div>
        </div>
        <input
          ref={avatarInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="上传角色头像文件"
          onChange={(event) => void selectAvatar(event)}
          hidden
          disabled={pending || readingAvatar}
        />
      </div>
      <div className="admin-form-grid">
        <Field label="角色名称">
          <input
            required
            maxLength={60}
            placeholder="角色的显示名称"
            value={draft.name}
            onChange={(event) => field('name', event.target.value)}
          />
        </Field>
        <Field label="角色标识" hint="小写字母、数字、下划线或连字符，用于 @ 角色。">
          <div className="admin-input-prefix">
            <span>@</span>
            <input
              required
              maxLength={40}
              pattern="[a-z0-9][a-z0-9_\-]{0,39}"
              placeholder="character-name"
              value={draft.slug}
              onChange={(event) => field('slug', event.target.value)}
            />
          </div>
        </Field>
      </div>
      <Field label="角色简介" hint="将展示在角色列表中，最多 500 字。">
        <textarea
          rows={2}
          maxLength={500}
          placeholder="简单介绍角色的身份、气质或擅长的话题。"
          value={draft.description}
          onChange={(event) => field('description', event.target.value)}
        />
      </Field>
      <Field
        label="角色人设"
        hint="定义身份、性格、语气、背景和互动边界。时间元数据与长期记忆由系统自动注入。"
      >
        <textarea
          className="admin-personality-input"
          required
          maxLength={20000}
          rows={7}
          placeholder="描述这个角色是谁，以及应当如何与用户交流…"
          value={draft.personality}
          onChange={(event) => field('personality', event.target.value)}
        />
      </Field>
      <Field label="开场白" hint="用户开始新对话时看到的欢迎语。">
        <textarea
          rows={3}
          maxLength={4000}
          placeholder="写下角色的第一句话…"
          value={draft.greeting}
          onChange={(event) => field('greeting', event.target.value)}
        />
      </Field>
      <div className="admin-form-grid admin-avatar-fields">
        <Field
          label="头像图片地址"
          hint={
            avatarDataUrl
              ? '已选择本地图片，保存时将使用上传的图片。'
              : draft.avatar.startsWith('/api/avatars/')
                ? '当前使用已上传的头像。填写新地址可替换；留空保留上传头像。'
                : '也可填写 HTTP / HTTPS 图片地址。'
          }
        >
          <input
            type="url"
            pattern="https?://.*"
            maxLength={2048}
            placeholder="https://example.com/avatar.png"
            value={draft.avatar.startsWith('/api/avatars/') ? '' : draft.avatar}
            disabled={pending || readingAvatar || !!avatarDataUrl}
            onChange={(event) => field('avatar', event.target.value)}
          />
        </Field>
        <Field label="角色主题色">
          <div className="admin-color-picker">
            <input
              type="color"
              value={draft.color}
              onChange={(event) => field('color', event.target.value)}
              aria-label="角色主题色"
            />
            <span>{draft.color.toUpperCase()}</span>
          </div>
        </Field>
      </div>
      <Field label="角色标签" hint="用逗号分隔，最多 10 个。">
        <input
          placeholder="友善，冒险，日常"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
      </Field>
      <Field label="关联模型">
        <Select value={draft.providerId} onValueChange={(value) => field('providerId', value)}>
          <option value="">暂不关联 · 保存为草稿</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {provider.model}
              {!modelAvailable(provider) ? '（暂不可用）' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {!providers.length && (
        <div className="admin-small-notice">
          <Cpu size={16} />
          尚未配置模型。可以先保存草稿，再到「供应商与模型」添加配置。
        </div>
      )}
      <Toggle
        checked={draft.active}
        onChange={(value) => field('active', value)}
        label="上架角色"
        description="上架后，所有已登录用户都可以与该角色对话。"
      />
      <FormFooter
        pending={pending || readingAvatar}
        onClose={onClose}
        label={item ? '保存角色' : '创建角色'}
      />
    </form>
  );
}

function SupplierEditor({
  item,
  onClose,
  onSaved,
}: {
  item?: SupplierConfig;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    name: item?.name ?? '',
    protocol: item?.protocol ?? ('openai-completions' as Protocol),
    baseUrl: item?.baseUrl ?? '',
    apiKey: '',
    active: item?.active ?? true,
  });
  const [clearKey, setClearKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  function changeProtocol(protocol: Protocol) {
    setDraft((previous) => ({
      ...previous,
      protocol,
      baseUrl:
        !previous.baseUrl || Object.values(supplierProtocolUrls).includes(previous.baseUrl)
          ? supplierProtocolUrls[protocol]
          : previous.baseUrl,
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    setPending(true);
    try {
      await api(
        item ? `/api/admin/suppliers/${item.id}` : '/api/admin/suppliers',
        json(item ? 'PATCH' : 'POST', {
          ...draft,
          name: draft.name.trim(),
          baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
          apiKey: clearKey ? '' : item && !draft.apiKey ? undefined : draft.apiKey,
        }),
      );
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="admin-form" onSubmit={submit}>
      <ErrorNote error={error} />
      <Field label="供应商名称">
        <input
          required
          maxLength={60}
          placeholder="输入供应商的显示名称"
          value={draft.name}
          onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
        />
      </Field>
      <Field label="API 协议" hint="该供应商下的对话模型统一继承此协议，修改后会影响全部关联模型。">
        <Select value={draft.protocol} onValueChange={(value) => changeProtocol(value as Protocol)}>
          {Object.entries(protocolNames).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="服务地址"
        hint="填写 API 基础地址，可包含版本路径，不包含具体接口路径。该供应商下的模型统一使用此地址。"
      >
        <input
          required
          type="url"
          pattern="https?://.*"
          maxLength={2048}
          placeholder={supplierProtocolUrls[draft.protocol]}
          value={draft.baseUrl}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, baseUrl: event.target.value }))
          }
        />
      </Field>
      <Field
        label="API 密钥"
        hint={
          item?.hasKey
            ? '密钥已加密保存。留空保留现有密钥，填写新值将更新全部关联模型的认证信息。'
            : '本地或无需认证的供应商可以留空。'
        }
      >
        <input
          type="password"
          autoComplete="new-password"
          maxLength={8192}
          disabled={clearKey}
          placeholder={item?.hasKey ? '••••••••（已加密保存）' : '输入供应商 API 密钥'}
          value={draft.apiKey}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, apiKey: event.target.value }))
          }
        />
      </Field>
      {item?.hasKey && (
        <Toggle
          label="清除已保存的密钥"
          description="仅适用于无需认证的服务，保存后对该供应商下的全部模型生效。"
          checked={clearKey}
          onChange={setClearKey}
        />
      )}
      <Toggle
        label="启用供应商"
        description="停用后，该供应商下的所有模型与关联角色暂不可用。"
        checked={draft.active}
        onChange={(value) => setDraft((previous) => ({ ...previous, active: value }))}
      />
      <FormFooter pending={pending} onClose={onClose} label={item ? '保存供应商' : '添加供应商'} />
    </form>
  );
}

function ProviderEditor({
  item,
  supplierId,
  suppliers,
  onClose,
  onSaved,
}: {
  item?: ProviderConfig;
  supplierId?: string;
  suppliers: SupplierConfig[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    supplierId: item?.supplierId ?? supplierId ?? suppliers[0]?.id ?? '',
    name: item?.name ?? '',
    model: item?.model ?? '',
    kind: item?.kind ?? ('language' as ModelKind),
    capabilities: item?.capabilities ?? (['text'] as ModelCapability[]),
    reasoningEffort: item?.reasoningEffort ?? ('default' as ReasoningEffort),
    thinkingBudget: item?.thinkingBudget == null ? '' : String(item.thinkingBudget),
    active: item?.active ?? true,
    contextWindow: item?.contextWindow ?? 32768,
    maxOutput: item?.maxOutput ?? 2048,
    temperature: item?.temperature == null ? '' : String(item.temperature),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const field = (key: keyof typeof draft, value: string | number | boolean | ModelCapability[]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const supplier = suppliers.find((entry) => entry.id === draft.supplierId);
  const reasoningOptions: ReasoningEffort[] =
    supplier?.protocol === 'anthropic'
      ? ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
      : supplier?.protocol === 'gemini'
        ? ['default', 'none', 'minimal', 'low', 'medium', 'high']
        : ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const supportsBudget = supplier?.protocol === 'anthropic' || supplier?.protocol === 'gemini';
  function chooseSupplier(value: string) {
    setDraft((previous) => ({
      ...previous,
      supplierId: value,
      reasoningEffort: 'default',
      thinkingBudget: '',
    }));
  }
  function chooseKind(value: ModelKind) {
    setDraft((previous) => ({
      ...previous,
      kind: value,
      capabilities: value === 'embedding' ? [] : ['text'],
      reasoningEffort: 'default',
      thinkingBudget: '',
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (!supplier) {
      setError('请选择一个供应商。');
      return;
    }
    if (draft.kind === 'embedding' && draft.active && supplier.protocol === 'anthropic') {
      setError('Anthropic Messages 不提供向量接口，请选择支持向量的供应商。');
      return;
    }
    if (draft.kind === 'language' && draft.maxOutput > draft.contextWindow / 2) {
      setError('最大输出不能超过上下文窗口的一半，请调整这两个参数。');
      return;
    }
    if (draft.kind === 'language' && draft.thinkingBudget && draft.reasoningEffort !== 'default') {
      setError('思考等级与思考预算不能同时设置，请选择其中一种方式。');
      return;
    }
    if (
      draft.kind === 'language' &&
      supportsBudget &&
      draft.thinkingBudget &&
      Number(draft.thinkingBudget) >= draft.maxOutput
    ) {
      setError('思考预算必须小于最大输出。');
      return;
    }
    setPending(true);
    try {
      await api(
        item ? `/api/admin/models/${item.id}` : '/api/admin/models',
        json(item ? 'PATCH' : 'POST', {
          supplierId: draft.supplierId,
          name: draft.name.trim(),
          model: draft.model.trim(),
          kind: draft.kind,
          active: draft.active,
          capabilities:
            draft.kind === 'embedding'
              ? []
              : [...new Set<ModelCapability>(['text', ...draft.capabilities])],
          reasoningEffort: draft.kind === 'embedding' ? 'default' : draft.reasoningEffort,
          thinkingBudget:
            draft.kind === 'embedding' || draft.thinkingBudget === ''
              ? null
              : Number(draft.thinkingBudget),
          ...(draft.kind === 'language'
            ? {
                contextWindow: draft.contextWindow,
                maxOutput: draft.maxOutput,
                temperature: draft.temperature === '' ? null : Number(draft.temperature),
              }
            : {}),
        }),
      );
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="admin-form" onSubmit={submit}>
      <ErrorNote error={error} />
      <div className="admin-form-grid">
        <Field label="所属供应商">
          <Select required value={draft.supplierId} onValueChange={chooseSupplier}>
            <option value="">选择供应商</option>
            {suppliers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
                {entry.active ? '' : '（已停用）'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="配置名称">
          <input
            required
            maxLength={60}
            placeholder="此模型在平台中的显示名称"
            value={draft.name}
            onChange={(event) => field('name', event.target.value)}
          />
        </Field>
      </div>
      <Field label="模型类型" hint="语言模型用于角色对话与摘要，向量模型用于长期记忆的语义检索。">
        <Select value={draft.kind} onValueChange={(value) => chooseKind(value as ModelKind)}>
          <option value="language">语言模型</option>
          <option value="embedding">向量模型</option>
        </Select>
      </Field>
      {supplier && (
        <div className="admin-model-source">
          <Globe2 size={17} />
          <span>
            <strong>继承供应商配置</strong>
            <small>
              {host(supplier.baseUrl)} · {supplier.hasKey ? '密钥已配置' : '未设置密钥'}
            </small>
          </span>
          <Badge tone={supplier.active ? 'green' : 'amber'}>
            {supplier.active ? '供应商已启用' : '供应商已停用'}
          </Badge>
        </div>
      )}
      <div className="admin-form-grid">
        <div className="admin-model-protocol">
          <span className="field-label">继承的 API 协议</span>
          <div>
            <Cpu size={16} />
            {supplier ? protocolNames[supplier.protocol] : '请先选择供应商'}
          </div>
          <small>协议由所属供应商统一配置。</small>
        </div>
        <Field label="模型名称" hint="填写供应商支持的完整模型 ID。">
          <input
            required
            maxLength={200}
            placeholder="模型 ID"
            value={draft.model}
            onChange={(event) => field('model', event.target.value)}
          />
        </Field>
      </div>
      {draft.kind === 'language' && (
        <>
          <fieldset className="admin-capability-fieldset">
            <legend className="field-label">模型能力声明</legend>
            <div className="admin-model-capabilities">
              {(Object.keys(capabilityNames) as ModelCapability[]).map((capability) => (
                <label
                  className={`admin-metadata-option ${draft.capabilities.includes(capability) || capability === 'text' ? 'is-selected' : ''}`}
                  key={capability}
                >
                  <input
                    type="checkbox"
                    checked={capability === 'text' || draft.capabilities.includes(capability)}
                    disabled={capability === 'text'}
                    onChange={(event) =>
                      field(
                        'capabilities',
                        event.target.checked
                          ? [...draft.capabilities, capability]
                          : draft.capabilities.filter((entry) => entry !== capability),
                      )
                    }
                  />
                  <span className="admin-metadata-check" aria-hidden="true">
                    <Check size={12} />
                  </span>
                  <strong>{capabilityNames[capability]}</strong>
                </label>
              ))}
            </div>
            <p>按实际模型支持情况填写；当前对话界面仅发送文本，勾选能力不会开启附件上传。</p>
          </fieldset>
          <div className="admin-form-divider">
            <span>生成参数</span>
          </div>
          <div className="admin-form-grid">
            <Field label="上下文窗口" hint="2,048 – 2,000,000 tokens">
              <input
                type="number"
                required
                min={2048}
                max={2000000}
                step={1}
                value={draft.contextWindow}
                onChange={(event) => field('contextWindow', Number(event.target.value))}
              />
            </Field>
            <Field label="最大输出" hint="不超过上下文窗口的一半。">
              <input
                type="number"
                required
                min={128}
                max={65536}
                step={1}
                value={draft.maxOutput}
                onChange={(event) => field('maxOutput', Number(event.target.value))}
              />
            </Field>
          </div>
          <Field
            label="Temperature"
            hint={`可选，范围 0–${supplier?.protocol === 'anthropic' ? '1' : '2'}；留空使用服务商默认值。部分模型不支持自定义该参数。`}
          >
            <input
              type="number"
              min={0}
              max={supplier?.protocol === 'anthropic' ? 1 : 2}
              step={0.05}
              placeholder="使用模型默认值"
              value={draft.temperature}
              onChange={(event) => field('temperature', event.target.value)}
            />
          </Field>
          <Field label="思考等级" hint="可用等级取决于协议与具体模型；不确定时保留模型默认。">
            <Select
              value={draft.reasoningEffort}
              disabled={!!draft.thinkingBudget}
              onValueChange={(value) => field('reasoningEffort', value as ReasoningEffort)}
            >
              {reasoningOptions.map((effort) => (
                <option key={effort} value={effort}>
                  {effortNames[effort]}
                </option>
              ))}
            </Select>
          </Field>
          {supportsBudget && (
            <Field
              label="思考预算"
              hint={
                supplier?.protocol === 'anthropic'
                  ? '可选，1,024–32,768 tokens，必须小于最大输出。与非默认思考等级互斥。'
                  : '可选，128–32,768 tokens，必须小于最大输出。与非默认思考等级互斥。'
              }
            >
              <input
                type="number"
                min={supplier?.protocol === 'anthropic' ? 1024 : 128}
                max={32768}
                step={1}
                disabled={draft.reasoningEffort !== 'default'}
                placeholder="留空使用模型默认预算"
                value={draft.thinkingBudget}
                onChange={(event) => field('thinkingBudget', event.target.value)}
              />
            </Field>
          )}
          {supplier?.protocol === 'gemini' && (
            <p className="admin-field-note">
              Gemini 2.5 系列使用思考预算；Gemini 3
              系列的可用思考等级取决于具体模型。请以供应商支持为准，默认选项不会发送额外控制参数。
            </p>
          )}
        </>
      )}
      {draft.kind === 'embedding' && (
        <div className="admin-small-notice">
          <Database size={17} />
          向量模型不使用对话生成、能力声明或思考参数。保存后可在「向量记忆」中选择该模型。
        </div>
      )}
      <Toggle
        checked={draft.active}
        onChange={(value) => field('active', value)}
        label="启用此模型"
        description="模型与所属供应商都启用后，才可供角色调用。"
      />
      {supplier && !supplier.active && (
        <div className="admin-small-notice">
          <AlertCircle size={16} />
          当前供应商已停用。模型配置可正常保存，启用供应商后才可用于对话。
        </div>
      )}
      <FormFooter
        pending={pending}
        onClose={onClose}
        label={item ? '保存模型配置' : '添加模型配置'}
      />
    </form>
  );
}
function embeddingDraft(config: EmbeddingConfig) {
  return {
    enabled: config.enabled,
    modelId: config.modelId ?? '',
    topK: config.topK,
    minSimilarity: config.minSimilarity,
  };
}

function EmbeddingEditor({
  config,
  models,
  onSaved,
}: {
  config: EmbeddingConfig;
  models: ProviderConfig[];
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => embeddingDraft(config));
  const [pending, setPending] = useState<'save' | 'test' | 'reindex' | null>(null);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [indexResult, setIndexResult] = useState<{
    indexed: number;
    failed: number;
    pending: number;
  } | null>(null);
  const [confirmIndex, setConfirmIndex] = useState(false);
  const model = models.find((entry) => entry.id === draft.modelId);
  const availableModels = models.filter(
    (entry) =>
      entry.kind === 'embedding' && modelAvailable(entry) && entry.protocol !== 'anthropic',
  );
  const supported = !!model && availableModels.some((entry) => entry.id === model.id);
  const savedAvailable = config.enabled && config.supplierActive === true;
  const dirty = JSON.stringify(draft) !== JSON.stringify(embeddingDraft(config));
  useEffect(() => {
    setDraft(embeddingDraft(config));
    setTestResult(null);
    setIndexResult(null);
  }, [config]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (draft.enabled && !supported) {
      setError('启用向量检索前，请选择一个可用的向量模型。');
      return;
    }
    setPending('save');
    try {
      await api<EmbeddingConfig>('/api/admin/embeddings', json('PATCH', draft));
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(null);
    }
  }

  async function test() {
    if (pending || dirty || !savedAvailable) return;
    setError('');
    setTestResult(null);
    setPending('test');
    try {
      const result = await api<{ ok: boolean; message: string }>(
        '/api/admin/embeddings/test',
        json('POST', {}),
      );
      if (result.ok) setTestResult(result.message || '向量模型连接正常');
      else setError(result.message || '向量模型连接测试失败');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(null);
    }
  }

  async function reindex() {
    if (pending || dirty || !savedAvailable) return;
    setError('');
    setPending('reindex');
    try {
      setIndexResult(
        await api<{ indexed: number; failed: number; pending: number }>(
          '/api/admin/embeddings/reindex',
          json('POST', {}),
        ),
      );
      setConfirmIndex(false);
    } catch (reason) {
      setError(errorMessage(reason));
      setConfirmIndex(false);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="admin-embedding" aria-labelledby="embedding-title">
      <div className="admin-embedding-heading">
        <span className="admin-embedding-icon">
          <Database size={23} strokeWidth={1.6} />
        </span>
        <div>
          <span className="admin-eyebrow">SEMANTIC MEMORY</span>
          <h3 id="embedding-title">向量记忆</h3>
          <p>从模型库选择向量模型，为长期记忆建立索引并检索相关内容。</p>
        </div>
        <Badge tone={savedAvailable ? 'green' : config.enabled ? 'amber' : 'neutral'}>
          {savedAvailable ? '已启用' : config.enabled ? '暂不可用' : '未启用'}
        </Badge>
      </div>
      <form
        className="admin-form admin-embedding-form"
        onSubmit={submit}
        aria-busy={pending === 'save'}
      >
        <fieldset className="admin-embedding-fields" disabled={pending === 'save'}>
          <ErrorNote error={error} />
          <Toggle
            checked={draft.enabled}
            onChange={(value) => setDraft((previous) => ({ ...previous, enabled: value }))}
            label="启用向量记忆检索"
            description="按当前对话内容检索相关记忆。协议、地址和密钥统一继承供应商配置。"
          />
          <Field label="向量模型" hint="仅展示模型库中已启用且供应商可用的向量模型。">
            <Select
              value={draft.modelId}
              disabled={pending === 'save'}
              onValueChange={(value) => setDraft((previous) => ({ ...previous, modelId: value }))}
            >
              <option value="">暂不关联向量模型</option>
              {draft.modelId && !availableModels.some((entry) => entry.id === draft.modelId) && (
                <option value={draft.modelId} disabled>
                  原向量模型已不可用，请重新选择
                </option>
              )}
              {availableModels.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {entry.model}
                  {entry.supplierName ? `（${entry.supplierName}）` : ''}
                </option>
              ))}
            </Select>
          </Field>
          {model && (
            <div className="admin-embedding-source">
              <div>
                <Globe2 size={16} />
                <strong>继承模型与供应商配置</strong>
                <Badge tone={supported ? 'green' : 'amber'}>
                  {supported ? '模型可用' : '模型不可用'}
                </Badge>
              </div>
              <dl>
                <div>
                  <dt>供应商</dt>
                  <dd>{model.supplierName || '—'}</dd>
                </div>
                <div>
                  <dt>API 协议</dt>
                  <dd>{protocolNames[model.protocol]}</dd>
                </div>
                <div>
                  <dt>服务地址</dt>
                  <dd>{model.baseUrl}</dd>
                </div>
                <div>
                  <dt>模型 ID</dt>
                  <dd>{model.model}</dd>
                </div>
                <div>
                  <dt>认证密钥</dt>
                  <dd>{model.hasKey ? '已在供应商中配置' : '未设置密钥'}</dd>
                </div>
              </dl>
              <p>模型 ID、协议和认证信息统一在供应商与模型中管理；这里仅配置检索参数。</p>
            </div>
          )}
          {!availableModels.length && (
            <div className="admin-small-notice">
              <Database size={17} />
              请先在上方的供应商中添加并启用一个向量模型，再启用向量检索。
            </div>
          )}
          {draft.modelId && !supported && (
            <div className="admin-small-notice">
              <AlertCircle size={17} />
              原向量模型或其供应商已不可用，请重新选择模型或关闭向量检索后保存。
            </div>
          )}
          <div className="admin-form-grid">
            <Field label="最多召回条数" hint="每次对话最多检索 1–12 条相关记忆。">
              <input
                required
                type="number"
                min={1}
                max={12}
                step={1}
                value={draft.topK}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, topK: Number(event.target.value) }))
                }
              />
            </Field>
            <Field label="最低相似度" hint="范围 0–1，数值越高，筛选的相关性要求越严格。">
              <input
                required
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={draft.minSimilarity}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    minSimilarity: Number(event.target.value),
                  }))
                }
              />
            </Field>
          </div>
          {testResult && !dirty && (
            <div className="admin-embedding-success" role="status">
              <Check size={17} />
              <span>{testResult}</span>
            </div>
          )}
          <div className="admin-embedding-actions">
            <span>
              {dirty
                ? '请先保存更改，再测试连接或更新索引。'
                : '测试与索引操作使用已保存的供应商及向量模型。'}
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={dirty || !savedAvailable || (pending !== null && pending !== 'test')}
              loading={pending === 'test'}
              onClick={() => void test()}
            >
              <Activity size={15} />
              测试向量连接
            </Button>
            <Button
              type="submit"
              disabled={!dirty || (pending !== null && pending !== 'save')}
              loading={pending === 'save'}
            >
              <Check size={16} />
              保存向量配置
            </Button>
          </div>
        </fieldset>
      </form>
      <div className="admin-embedding-index">
        <div>
          <h4>
            <RefreshCw size={15} />
            索引维护
          </h4>
          <p>
            为所有用户的待处理记忆建立索引，每批最多处理 16
            条。更换供应商连接配置或向量模型后，需要重新建立索引。
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={dirty || !savedAvailable || pending !== null}
          onClick={() => setConfirmIndex(true)}
        >
          <Database size={15} />
          {indexResult && indexResult.pending > 0 ? '继续处理索引' : '更新向量索引'}
        </Button>
      </div>
      {indexResult && (
        <div className="admin-index-result" role="status">
          <span>
            <strong>{indexResult.indexed}</strong> 本次已索引
          </span>
          <span className={indexResult.failed ? 'has-failures' : ''}>
            <strong>{indexResult.failed}</strong> 本次失败
          </span>
          <span>
            <strong>{indexResult.pending}</strong> 仍待处理
          </span>
          {indexResult.failed > 0 && <p>部分记忆索引失败，请检查供应商连接后重试。</p>}
          {indexResult.pending > 0 && <p>仍有记忆等待索引，可以继续处理下一批。</p>}
        </div>
      )}
      <div className="admin-info-line admin-embedding-fees">
        <ShieldCheck size={15} />
        <p>
          向量请求不扣除聊天调用额度；供应商可能单独计费。记忆内容只在对应用户与角色的范围内检索。
        </p>
      </div>
      <Modal
        open={confirmIndex}
        onClose={() => {
          if (!pending) setConfirmIndex(false);
        }}
        title="更新向量索引"
        description="使用已保存的供应商与向量模型处理记忆。"
      >
        <div className="admin-form">
          <div className="admin-small-notice">
            <Database size={18} />
            <span>
              本次将为最多 16 条待处理记忆生成向量。原始记忆内容保持不变；此操作可能产生供应商费用。
            </span>
          </div>
          <dl className="admin-index-config">
            <div>
              <dt>供应商</dt>
              <dd>{config.supplierName || '—'}</dd>
            </div>
            <div>
              <dt>向量接口</dt>
              <dd>{config.protocol === 'gemini' ? 'Gemini Native' : 'OpenAI Compatible'}</dd>
            </div>
            <div>
              <dt>服务地址</dt>
              <dd>{config.baseUrl}</dd>
            </div>
            <div>
              <dt>向量模型</dt>
              <dd>{config.model}</dd>
            </div>
          </dl>
          <div className="admin-form-footer">
            <Button
              type="button"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => setConfirmIndex(false)}
            >
              取消
            </Button>
            <Button type="button" loading={pending === 'reindex'} onClick={() => void reindex()}>
              <RefreshCw size={15} />
              开始处理
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
function AnnouncementEditor({
  item,
  onClose,
  onSaved,
}: {
  item?: Announcement;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    title: item?.title ?? '',
    content: item?.content ?? '',
    published: item?.published ?? false,
    pinned: item?.pinned ?? false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (!draft.title.trim() || !draft.content.trim()) {
      setError('请填写公告标题与正文。');
      return;
    }
    setPending(true);
    try {
      await api(
        item ? `/api/admin/announcements/${item.id}` : '/api/admin/announcements',
        json(item ? 'PATCH' : 'POST', {
          ...draft,
          title: draft.title.trim(),
          content: draft.content.trim(),
        }),
      );
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="admin-form" onSubmit={submit}>
      <ErrorNote error={error} />
      <Field label="公告标题">
        <input
          required
          maxLength={160}
          placeholder="输入公告标题"
          value={draft.title}
          onChange={(event) => setDraft((previous) => ({ ...previous, title: event.target.value }))}
        />
      </Field>
      <Field label="公告正文" hint={`${draft.content.length.toLocaleString()} / 20,000 字`}>
        <textarea
          required
          maxLength={20000}
          rows={10}
          placeholder="输入公告正文…"
          value={draft.content}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, content: event.target.value }))
          }
        />
      </Field>
      <Toggle
        label="发布公告"
        description="关闭时仅保存为草稿，用户不可见。"
        checked={draft.published}
        onChange={(value) => setDraft((previous) => ({ ...previous, published: value }))}
      />
      <Toggle
        label="置顶展示"
        description="在公告列表顶部优先展示。"
        checked={draft.pinned}
        onChange={(value) => setDraft((previous) => ({ ...previous, pinned: value }))}
      />
      <FormFooter
        pending={pending}
        onClose={onClose}
        label={draft.published ? '保存并发布' : '保存草稿'}
      />
    </form>
  );
}

function UserEditor({
  item,
  isSelf,
  onClose,
  onSaved,
}: {
  item: User;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    role: item.role,
    disabled: item.disabled,
    limit5h: item.limit5h,
    limit7d: item.limit7d,
    characterSlots: item.characterSlots ?? 3,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    setPending(true);
    try {
      await api(`/api/admin/users/${item.id}`, json('PATCH', draft));
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="admin-form" onSubmit={submit}>
      <ErrorNote error={error} />
      {isSelf && (
        <div className="admin-small-notice">
          <ShieldCheck size={17} />
          正在修改你自己的账户。更改权限或停用后可能失去控制台访问权限。
        </div>
      )}
      <Field label="账户角色">
        <Select
          value={draft.role}
          onValueChange={(value) =>
            setDraft((previous) => ({ ...previous, role: value as User['role'] }))
          }
        >
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </Select>
      </Field>
      <div className="admin-form-grid">
        <Field label="5 小时调用上限">
          <input
            required
            type="number"
            min={0}
            max={1000000}
            step={1}
            value={draft.limit5h}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, limit5h: Number(event.target.value) }))
            }
          />
        </Field>
        <Field label="7 天调用上限">
          <input
            required
            type="number"
            min={0}
            max={1000000}
            step={1}
            value={draft.limit7d}
            onChange={(event) =>
              setDraft((previous) => ({ ...previous, limit7d: Number(event.target.value) }))
            }
          />
        </Field>
      </div>
      <p className="admin-field-note">
        两个滚动窗口会同时检查。调整上限不会清空当前调用计数；设为 0 时无法发起新的模型调用。
      </p>
      <Field
        label="个人角色槽位"
        hint="允许 0–100 个。停用角色也占槽位，删除后释放；降低上限不会删除已有角色。下一次修改全局槽位时将同步覆盖此设置。"
      >
        <input
          required
          type="number"
          min={0}
          max={100}
          step={1}
          value={draft.characterSlots}
          onChange={(event) =>
            setDraft((previous) => ({ ...previous, characterSlots: Number(event.target.value) }))
          }
        />
      </Field>
      <Toggle
        label="停用账户"
        description="停用后，该用户无法继续访问平台。"
        checked={draft.disabled}
        onChange={(value) => setDraft((previous) => ({ ...previous, disabled: value }))}
      />
      <FormFooter pending={pending} onClose={onClose} />
    </form>
  );
}

function SettingsEditor({
  settings,
  onSaved,
}: {
  settings: PlatformSettings;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [hiddenSymbolsText, setHiddenSymbolsText] = useState(
    (settings.hiddenSymbols ?? []).join('\n'),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(settings);
    setHiddenSymbolsText((settings.hiddenSymbols ?? []).join('\n'));
  }, [settings]);
  const hiddenSymbols = [
    ...new Set(hiddenSymbolsText.split(/\r?\n/).filter((value) => value.length > 0)),
  ];
  const dirty = JSON.stringify({ ...draft, hiddenSymbols }) !== JSON.stringify(settings);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (hiddenSymbols.length > 20 || hiddenSymbols.some((symbol) => symbol.length > 20)) {
      setError('最多配置 20 条隐藏符号，每条不超过 20 字。');
      return;
    }
    setPending(true);
    try {
      await api(
        '/api/admin/settings',
        json('PATCH', {
          registrationOpen: draft.registrationOpen,
          defaultLimit5h: draft.defaultLimit5h,
          defaultLimit7d: draft.defaultLimit7d,
          defaultCharacterSlots: draft.defaultCharacterSlots ?? 3,
          maxGroupRounds: draft.maxGroupRounds,
          siteDescription: draft.siteDescription,
          bubbleDelimiter: draft.bubbleDelimiter,
          hiddenSymbols,
          auditCaptureContent: draft.auditCaptureContent,
          auditRetentionDays: draft.auditRetentionDays,
        }),
      );
      await onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <SectionTitle
        eyebrow="MAKE IT YOURS"
        title="平台设置"
        description="管理注册入口、调用限额、角色槽位、消息展示与请求记录。"
      />
      <form onSubmit={submit} className="admin-settings-form">
        <ErrorNote error={error} />
        <section className="admin-settings-section">
          <div className="admin-settings-description">
            <span className="admin-settings-index">01</span>
            <h3>平台与访问</h3>
            <p>让新用户了解你的社区，并决定是否开放注册。</p>
          </div>
          <div className="admin-settings-fields">
            <Field label="平台简介" hint="展示在平台入口，最多 300 字。">
              <textarea
                rows={3}
                maxLength={300}
                value={draft.siteDescription}
                placeholder="输入平台简介…"
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, siteDescription: event.target.value }))
                }
              />
            </Field>
            <Toggle
              checked={draft.registrationOpen}
              onChange={(value) =>
                setDraft((previous) => ({ ...previous, registrationOpen: value }))
              }
              label="开放用户注册"
              description="关闭后，已有用户仍然可以正常登录。"
            />
          </div>
        </section>
        <section className="admin-settings-section">
          <div className="admin-settings-description">
            <span className="admin-settings-index">02</span>
            <h3>全局调用限额</h3>
            <p>
              修改后立即同步所有用户的对应限额，保留已用次数。单用户调整会被下一次全局修改覆盖。
            </p>
          </div>
          <div className="admin-settings-fields">
            <div className="admin-form-grid">
              <Field label="5 小时调用上限">
                <input
                  type="number"
                  required
                  min={0}
                  max={1000000}
                  step={1}
                  value={draft.defaultLimit5h}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      defaultLimit5h: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="7 天调用上限">
                <input
                  type="number"
                  required
                  min={0}
                  max={1000000}
                  step={1}
                  value={draft.defaultLimit7d}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      defaultLimit7d: Number(event.target.value),
                    }))
                  }
                />
              </Field>
            </div>
            <p className="admin-field-note">
              按成功的模型调用次数计量。两个周期采用滚动窗口，任一窗口额度耗尽时暂停调用。
            </p>
          </div>
        </section>
        <section className="admin-settings-section">
          <div className="admin-settings-description">
            <span className="admin-settings-index">03</span>
            <h3>用户角色槽位</h3>
            <p>用户创建的角色仅本人可见和使用，不会发布到角色广场。</p>
          </div>
          <div className="admin-settings-fields">
            <Field
              label="全局用户角色槽位"
              hint="允许 0–100 个。修改后立即同步所有用户；新注册用户也使用此数量。设置为 0 时暂停创建新角色。"
            >
              <input
                required
                type="number"
                min={0}
                max={100}
                step={1}
                value={draft.defaultCharacterSlots ?? 3}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    defaultCharacterSlots: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <p className="admin-field-note">
              启用和停用的角色都占槽位，删除后释放。降低槽位不会删除已有角色，也不影响其继续使用。可在「用户与限额」单独调整；下一次全局修改会同步覆盖。
            </p>
          </div>
        </section>
        <section className="admin-settings-section">
          <div className="admin-settings-description">
            <span className="admin-settings-index">04</span>
            <h3>群聊响应规则</h3>
            <p>为角色之间的互动设置清晰的停止边界。</p>
          </div>
          <div className="admin-settings-fields">
            <Field
              label="每条消息的最大角色响应轮数"
              hint="允许 1–12 轮，包含用户 @ 角色和角色 @ 其他角色触发的所有响应。"
            >
              <input
                type="number"
                required
                min={1}
                max={12}
                step={1}
                value={draft.maxGroupRounds}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    maxGroupRounds: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <div className="admin-small-notice">
              <Users size={17} />
              用户可以自由发言；只有 @
              角色时才触发响应。达到最大轮数后，角色之间的接续响应会自动停止。
            </div>
          </div>
        </section>
        <section className="admin-settings-section">
          <div className="admin-settings-description">
            <span className="admin-settings-index">05</span>
            <h3>消息展示</h3>
            <p>调整角色回复的气泡拆分与符号显示，保留完整的原始对话内容。</p>
          </div>
          <div className="admin-settings-fields">
            <Field
              label="气泡分隔符"
              hint="可选，最多 32 字，按完整文本匹配。一次回复可展示为多个气泡，仍只计一次模型调用。"
            >
              <input
                maxLength={32}
                placeholder="留空时不拆分回复"
                value={draft.bubbleDelimiter ?? ''}
                onChange={(event) =>
                  setDraft((previous) => ({ ...previous, bubbleDelimiter: event.target.value }))
                }
              />
            </Field>
            <Field
              label="隐藏符号"
              hint={`每行一个符号，按原样匹配，空行忽略。最多 20 条，每条最多 20 字；当前 ${hiddenSymbols.length} 条，保存时自动去重。`}
            >
              <textarea
                rows={4}
                maxLength={2000}
                placeholder="每行输入一个需要隐藏的符号或文本片段"
                value={hiddenSymbolsText}
                onChange={(event) => setHiddenSymbolsText(event.target.value)}
              />
            </Field>
            <div className="admin-small-notice">
              <FileText size={17} />
              先按分隔符拆分气泡，再隐藏所列符号。仅影响消息展示、复制与导出，原始消息及模型上下文保持不变。
            </div>
          </div>
        </section>
        <section className="admin-settings-section">
          <div className="admin-settings-description">
            <span className="admin-settings-index">06</span>
            <h3>请求记录</h3>
            <p>配置请求审查的数据范围和保留时间。</p>
          </div>
          <div className="admin-settings-fields">
            <Toggle
              checked={draft.auditCaptureContent}
              onChange={(value) =>
                setDraft((previous) => ({ ...previous, auditCaptureContent: value }))
              }
              label="记录请求与响应内容"
              description="开启后可能保存用户对话、角色人设等内容；认证凭据不会记录。默认仅记录元数据。"
            />
            <Field label="请求记录保留天数" hint="允许 1–90 天。缩短期限可能清理更早的请求记录。">
              <input
                type="number"
                required
                min={1}
                max={90}
                step={1}
                value={draft.auditRetentionDays}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    auditRetentionDays: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <div className="admin-small-notice">
              <ShieldCheck size={17} />
              关闭内容捕获后，新请求仅保存元数据；已保存的记录仍按保留期限清理。请求重试会单独记录，不改变用户调用额度的计量方式。
            </div>
          </div>
        </section>
        <div className="admin-settings-footer">
          <span>{dirty ? '有尚未保存的更改' : '所有设置已保存'}</span>
          <Button loading={pending} disabled={!dirty} type="submit">
            <Check size={16} />
            保存平台设置
          </Button>
        </div>
      </form>
    </>
  );
}

function ConfirmAction({
  confirmation,
  onClose,
  onDone,
}: {
  confirmation: NonNullable<Confirmation>;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (confirmation.phrase && value !== confirmation.phrase) return;
    setError('');
    setPending(true);
    try {
      await confirmation.action();
      await onDone();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="admin-form">
      <div className="admin-confirm-note">
        <AlertCircle size={23} />
        <p>{confirmation.description}</p>
      </div>
      <ErrorNote error={error} />
      {confirmation.phrase && (
        <Field label={`输入「${confirmation.phrase}」以继续`}>
          <input
            autoComplete="off"
            placeholder={confirmation.phrase}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      )}
      <div className="admin-form-footer">
        <Button variant="ghost" type="button" onClick={onClose} disabled={pending}>
          取消
        </Button>
        <Button
          type="submit"
          variant="danger"
          loading={pending}
          disabled={!!confirmation.phrase && value !== confirmation.phrase}
        >
          {confirmation.label}
        </Button>
      </div>
    </form>
  );
}
