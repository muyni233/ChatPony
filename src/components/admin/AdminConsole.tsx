'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  CirclePlus,
  Database,
  FilePenLine,
  Globe2,
  LayoutGrid,
  LoaderCircle,
  Megaphone,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { api } from '@/lib/client';
import type { Character, Provider, User } from '@/lib/types';
import CharacterEditor from './CharacterEditor';
import ProviderEditor, { protocolNames } from './ProviderEditor';
import Dialog from './Dialog';
import SiteSettings from './SiteSettings';
import RequestAudit from './RequestAudit';
import AnnouncementManager from './AnnouncementManager';
import UserDirectory from './UserDirectory';

type Tab =
  'overview' | 'characters' | 'providers' | 'users' | 'announcements' | 'audit' | 'settings';
type Stats = {
  users: number;
  characters: number;
  conversations: number;
  messages: number;
  providers: number;
};
const tabs = [
  { key: 'overview' as const, label: '概览', icon: LayoutGrid },
  { key: 'characters' as const, label: '角色管理', icon: Sparkles },
  { key: 'providers' as const, label: '模型接口', icon: Settings2 },
  { key: 'users' as const, label: '用户管理', icon: Users },
  { key: 'announcements' as const, label: '公告管理', icon: Megaphone },
  { key: 'audit' as const, label: '请求审计', icon: ScrollText },
  { key: 'settings' as const, label: '站点设置', icon: Globe2 },
];
const emptyStats: Stats = { users: 0, characters: 0, conversations: 0, messages: 0, providers: 0 };

export default function AdminConsole() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [stats, setStats] = useState<Stats>(emptyStats);
  const [characterEditor, setCharacterEditor] = useState<Character | null | undefined>(undefined);
  const [providerEditor, setProviderEditor] = useState<Provider | null | undefined>(undefined);
  const [auditRevision, setAuditRevision] = useState(0);
  const [deletion, setDeletion] = useState<{
    kind: 'characters' | 'providers';
    id: string;
    name: string;
  } | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [characterFilter, setCharacterFilter] = useState('all');

  const refresh = useCallback(async () => {
    setAuditRevision((previous) => previous + 1);
    setRefreshing(true);
    setLoadError('');
    try {
      const [characterResult, providerResult, statResult] = await Promise.all([
        api<{ characters: Character[] }>('/api/admin/characters'),
        api<{ providers: Provider[] }>('/api/admin/providers'),
        api<Stats>('/api/admin/stats'),
      ]);
      setCharacters(characterResult.characters);
      setProviders(providerResult.providers);
      setStats(statResult);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : '管理数据加载失败，请重试。');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    api<{ user: User | null }>('/api/session')
      .then(async (result) => {
        if (!active) return;
        setUser(result.user);
        const requested = new URLSearchParams(window.location.search).get('tab');
        if (tabs.some((item) => item.key === requested)) setTab(requested as Tab);
        if (result.user?.role === 'admin') await refresh();
      })
      .catch((cause) => {
        if (active) setLoadError(cause instanceof Error ? cause.message : '无法读取登录状态。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  function changeTab(next: Tab) {
    setTab(next);
    setQuery('');
    setNotice(null);
    window.history.replaceState(null, '', next === 'overview' ? '/admin' : `/admin?tab=${next}`);
  }

  async function mutate(id: string, action: () => Promise<unknown>, success: string) {
    setBusy(id);
    setNotice(null);
    try {
      await action();
      setNotice({ text: success, error: false });
      await refresh();
    } catch (cause) {
      setNotice({
        text: cause instanceof Error ? cause.message : '操作失败，请稍后重试。',
        error: true,
      });
    } finally {
      setBusy('');
    }
  }

  function saved(kind: 'character' | 'provider') {
    setCharacterEditor(undefined);
    setProviderEditor(undefined);
    setNotice({ text: kind === 'character' ? '角色已保存。' : '模型接口已保存。', error: false });
    void refresh();
  }

  async function confirmDelete() {
    if (!deletion) return;
    const record = deletion;
    setBusy(record.id);
    setNotice(null);
    try {
      await api(`/api/admin/${record.kind}/${record.id}`, { method: 'DELETE' });
      setDeletion(null);
      setNotice({
        text: `${record.kind === 'characters' ? '角色' : '接口'}已删除。`,
        error: false,
      });
      await refresh();
    } catch (cause) {
      setDeletion(null);
      setNotice({
        text: cause instanceof Error ? cause.message : '删除失败，请重试。',
        error: true,
      });
    } finally {
      setBusy('');
    }
  }

  async function testProvider(provider: Provider) {
    setBusy(provider.id);
    setNotice(null);
    try {
      const result = await api<{ ok: boolean; message: string }>(
        `/api/admin/providers/${provider.id}/test`,
        { method: 'POST', body: '{}' },
      );
      setNotice({
        text: `${provider.name}：${result.message || (result.ok ? '连接成功' : '连接失败')}`,
        error: !result.ok,
      });
    } catch (cause) {
      setNotice({
        text: cause instanceof Error ? cause.message : '连接测试失败，请检查接口配置。',
        error: true,
      });
    } finally {
      setBusy('');
    }
  }

  const filteredCharacters = useMemo(
    () =>
      characters.filter(
        (character) =>
          (characterFilter === 'all' ||
            (characterFilter === 'published' ? character.published : !character.published)) &&
          `${character.name} ${character.englishName} ${character.tags.join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [characters, characterFilter, query],
  );
  const published = characters.filter((character) => character.published).length;
  const activeProviders = providers.filter(
    (provider) => provider.enabled && provider.hasApiKey,
  ).length;
  const defaultProvider = providers.find((provider) => provider.isDefault && provider.enabled);

  if (loading)
    return (
      <div className="account-loading">
        <LoaderCircle size={24} className="spin" />
        <p>正在读取管理工作台…</p>
      </div>
    );
  if (!user || user.role !== 'admin')
    return (
      <div className="empty-state">
        <ShieldCheck size={32} />
        <h2>{user ? '这里需要管理员权限' : '登录后访问管理后台'}</h2>
        <p>
          {user
            ? '你的账户可以正常使用平台对话。管理权限由站点管理员分配。'
            : '请使用管理员账户登录。'}
        </p>
        {loadError && (
          <p className="error-message" role="alert">
            {loadError}
          </p>
        )}
        <Link href={user ? '/' : '/login'} className="button button-primary">
          {user ? '回到首页' : '前往登录'}
        </Link>
      </div>
    );

  return (
    <div className="admin-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">BEHIND THE STORIES</p>
          <h1>
            管理工作台<span className="account-heading-star">✳</span>
          </h1>
          <p className="muted">为每一个角色、每一次相遇，做好准备。</p>
        </div>
        <button
          className="button button-secondary admin-refresh"
          onClick={() => void refresh()}
          disabled={refreshing || !!busy}
        >
          <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
          {refreshing ? '更新中' : '刷新数据'}
        </button>
      </header>
      <nav className="admin-tabs" aria-label="管理功能">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? 'is-active' : ''}
            aria-current={tab === item.key ? 'page' : undefined}
            onClick={() => changeTab(item.key)}
          >
            <item.icon size={17} />
            {item.label}
            {item.key === 'characters' && <span>{characters.length}</span>}
            {item.key === 'providers' && <span>{providers.length}</span>}
          </button>
        ))}
      </nav>
      {loadError && (
        <div className="admin-notice is-error" role="alert">
          <p>{loadError}</p>
          <button
            className="button button-ghost"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            重新加载
          </button>
        </div>
      )}
      {notice && (
        <div
          className={`admin-notice${notice.error ? ' is-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <Activity size={17} /> : <CheckCircle2 size={17} />}
          <p>{notice.text}</p>
          <button
            className="admin-icon-button"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            <X size={17} />
          </button>
        </div>
      )}

      {tab === 'overview' && (
        <div className="admin-overview">
          <div className="admin-stat-grid">
            {[
              { label: '注册用户', value: stats.users, icon: Users, note: '所有已注册账户' },
              {
                label: '已发布角色',
                value: published,
                icon: Sparkles,
                note: `共 ${stats.characters} 位角色`,
              },
              {
                label: '累计对话',
                value: stats.conversations,
                icon: MessageSquare,
                note: `${stats.messages.toLocaleString()} 条消息`,
              },
              {
                label: '可用接口',
                value: activeProviders,
                icon: Radio,
                note: `共 ${stats.providers} 个模型接口`,
              },
            ].map((item, index) => (
              <div className="admin-stat" key={item.label}>
                <div>
                  <span>{item.label}</span>
                  <item.icon size={18} />
                </div>
                <strong>{item.value.toLocaleString()}</strong>
                <footer>
                  <span>{item.note}</span>
                  <small>0{index + 1}</small>
                </footer>
              </div>
            ))}
          </div>
          <div className="admin-overview-columns">
            <section className="admin-setup">
              <div className="admin-section-heading">
                <div>
                  <span className="eyebrow">GETTING EVERYTHING READY</span>
                  <h2>让平台准备就绪</h2>
                </div>
                <span className="admin-small-index">01—03</span>
              </div>
              <p className="muted">按照这三步，让用户开始第一段对话。</p>
              {[
                {
                  ready: activeProviders > 0,
                  title: '连接模型接口',
                  text: '添加一个可用接口，并测试连接。',
                  to: 'providers' as const,
                },
                {
                  ready: !!defaultProvider,
                  title: '选择默认模型',
                  text: '为新建对话指定默认的模型接口。',
                  to: 'providers' as const,
                },
                {
                  ready: published > 0,
                  title: '创建并发布角色',
                  text: '填写角色资料与人设，准备好后发布。',
                  to: 'characters' as const,
                },
              ].map((step, index) => (
                <button
                  className="admin-setup-step"
                  key={step.title}
                  onClick={() => changeTab(step.to)}
                >
                  <span className={`admin-step-check${step.ready ? ' is-complete' : ''}`}>
                    {step.ready ? <Check size={17} /> : `0${index + 1}`}
                  </span>
                  <span>
                    <strong>{step.title}</strong>
                    <small>{step.text}</small>
                  </span>
                  <ArrowRight size={17} />
                </button>
              ))}
            </section>
            <aside className="admin-status-note">
              <span className="admin-note-label">
                <Database size={17} /> PLATFORM NOTES
              </span>
              <h2>
                一点设置，
                <br />
                许多可能。
              </h2>
              <p>
                角色与模型配置由管理员统一管理。已发布角色会同步出现在角色目录中，草稿仅管理员可见。
              </p>
              <dl>
                <div>
                  <dt>默认接口</dt>
                  <dd>{defaultProvider?.name ?? '尚未设置'}</dd>
                </div>
                <div>
                  <dt>角色状态</dt>
                  <dd>{published ? `${published} 位已发布` : '等待第一位角色'}</dd>
                </div>
                <div>
                  <dt>当前管理员</dt>
                  <dd>{user.username}</dd>
                </div>
              </dl>
              <span className="admin-note-star">✳</span>
            </aside>
          </div>
        </div>
      )}

      {tab === 'characters' && (
        <section className="admin-list-section">
          <div className="admin-section-heading">
            <div>
              <h2>角色目录</h2>
              <p>在这里创建人设、编辑资料并管理发布状态。</p>
            </div>
            <button className="button button-primary" onClick={() => setCharacterEditor(null)}>
              <Plus size={17} />
              创建角色
            </button>
          </div>
          <div className="admin-list-toolbar">
            <div className="admin-segmented" aria-label="角色状态筛选">
              {[
                { key: 'all', label: '全部角色' },
                { key: 'published', label: '已发布' },
                { key: 'draft', label: '草稿' },
              ].map((filter) => (
                <button
                  key={filter.key}
                  className={characterFilter === filter.key ? 'is-active' : ''}
                  aria-pressed={characterFilter === filter.key}
                  onClick={() => setCharacterFilter(filter.key)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <label className="admin-search">
              <Search size={16} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索角色名称或标签"
                aria-label="搜索角色"
              />
            </label>
          </div>
          {characters.length === 0 ? (
            <div className="admin-empty">
              <span className="admin-empty-symbol">
                <CirclePlus size={31} strokeWidth={1.2} />
              </span>
              <span className="eyebrow">A NEW CHARACTER STARTS HERE</span>
              <h3>为第一位角色，写下设定</h3>
              <p>
                还没有配置角色。添加资料与人设后，
                <br />
                你可以先保存草稿，再选择何时发布。
              </p>
              <button className="button button-primary" onClick={() => setCharacterEditor(null)}>
                <Plus size={16} />
                创建第一个角色
              </button>
            </div>
          ) : filteredCharacters.length === 0 ? (
            <div className="admin-empty admin-empty-compact">
              <Search size={24} />
              <h3>没有找到匹配的角色</h3>
              <p>试着调整关键词或筛选条件。</p>
            </div>
          ) : (
            <div className="admin-character-list">
              {filteredCharacters.map((character) => (
                <article key={character.id} className="admin-character-row">
                  <span
                    className="admin-character-mark"
                    style={{ '--character-color': character.color } as React.CSSProperties}
                  >
                    {character.name.slice(0, 1)}
                  </span>
                  <div className="admin-character-info">
                    <div>
                      <h3>{character.name}</h3>
                      <span
                        className={`admin-status-badge ${character.published ? 'is-published' : ''}`}
                      >
                        <Circle size={6} fill="currentColor" />
                        {character.published ? '已发布' : '草稿'}
                      </span>
                    </div>
                    <p>{character.subtitle || character.description}</p>
                    {character.tags.length > 0 && (
                      <div className="admin-character-tags">
                        {character.tags.slice(0, 4).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="admin-row-actions">
                    <button
                      className="button button-ghost"
                      disabled={!!busy}
                      onClick={() =>
                        void mutate(
                          character.id,
                          () =>
                            api(`/api/admin/characters/${character.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ published: !character.published }),
                            }),
                          character.published ? '角色已下架，新对话中将不再显示。' : '角色已发布。',
                        )
                      }
                    >
                      {busy === character.id ? <LoaderCircle className="spin" size={15} /> : null}
                      {character.published ? '下架' : '发布'}
                    </button>
                    <button
                      className="admin-icon-button"
                      disabled={!!busy}
                      aria-label={`编辑 ${character.name}`}
                      title="编辑角色"
                      onClick={() => setCharacterEditor(character)}
                    >
                      <FilePenLine size={17} />
                    </button>
                    <button
                      className="admin-icon-button is-danger"
                      disabled={!!busy}
                      aria-label={`删除 ${character.name}`}
                      title="删除角色"
                      onClick={() =>
                        setDeletion({ kind: 'characters', id: character.id, name: character.name })
                      }
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'providers' && (
        <section className="admin-list-section">
          <div className="admin-section-heading">
            <div>
              <h2>模型接口</h2>
              <p>四种原生协议，共用一套对话体验。</p>
            </div>
            <button className="button button-primary" onClick={() => setProviderEditor(null)}>
              <Plus size={17} />
              添加接口
            </button>
          </div>
          <div className="admin-protocol-strip">
            {Object.values(protocolNames).map((protocol) => (
              <span key={protocol}>
                <span />
                {protocol}
              </span>
            ))}
          </div>
          {providers.length === 0 ? (
            <div className="admin-empty">
              <span className="admin-empty-symbol">
                <Radio size={31} strokeWidth={1.2} />
              </span>
              <span className="eyebrow">CONNECT THE POSSIBILITIES</span>
              <h3>连接你的第一个模型</h3>
              <p>
                添加模型服务商的 API 地址与密钥，
                <br />
                让角色拥有自然对话的能力。
              </p>
              <button className="button button-primary" onClick={() => setProviderEditor(null)}>
                <Plus size={16} />
                添加模型接口
              </button>
            </div>
          ) : (
            <div className="admin-provider-list">
              {providers.map((provider) => (
                <article className="admin-provider-row" key={provider.id}>
                  <div className="admin-provider-top">
                    <span
                      className={`admin-provider-status${provider.enabled ? ' is-enabled' : ''}`}
                    >
                      <span />
                      {provider.enabled ? '已启用' : '已停用'}
                    </span>
                    {provider.isDefault && <span className="admin-default-badge">默认接口</span>}
                    <span className="admin-provider-protocol">
                      {protocolNames[provider.protocol]}
                    </span>
                    <div className="admin-row-actions">
                      <button
                        className="admin-icon-button"
                        disabled={!!busy}
                        aria-label={`编辑 ${provider.name}`}
                        title="编辑接口"
                        onClick={() => setProviderEditor(provider)}
                      >
                        <FilePenLine size={17} />
                      </button>
                      <button
                        className="admin-icon-button is-danger"
                        disabled={!!busy}
                        aria-label={`删除 ${provider.name}`}
                        title="删除接口"
                        onClick={() =>
                          setDeletion({ kind: 'providers', id: provider.id, name: provider.name })
                        }
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </div>
                  <div className="admin-provider-main">
                    <div>
                      <h3>{provider.name}</h3>
                      <code>{provider.model}</code>
                      <p title={provider.baseUrl}>{provider.baseUrl}</p>
                    </div>
                    <dl>
                      <div>
                        <dt>上下文窗口</dt>
                        <dd>
                          {provider.contextWindow.toLocaleString()} <small>tokens</small>
                        </dd>
                      </div>
                      <div>
                        <dt>最大输出</dt>
                        <dd>
                          {provider.maxOutputTokens.toLocaleString()} <small>tokens</small>
                        </dd>
                      </div>
                      <div>
                        <dt>密钥状态</dt>
                        <dd className={provider.hasApiKey ? 'key-configured' : 'key-missing'}>
                          {provider.hasApiKey ? '已加密保存' : '未配置'}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <footer className="admin-provider-footer">
                    <span>
                      Temperature <strong>{provider.temperature}</strong>
                    </span>
                    <div>
                      {!provider.isDefault && provider.enabled && (
                        <button
                          className="button button-ghost"
                          disabled={!!busy}
                          onClick={() =>
                            void mutate(
                              provider.id,
                              () =>
                                api(`/api/admin/providers/${provider.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ isDefault: true }),
                                }),
                              '默认模型接口已更新。',
                            )
                          }
                        >
                          设为默认
                        </button>
                      )}
                      <button
                        className="button button-ghost"
                        disabled={!!busy}
                        onClick={() =>
                          void mutate(
                            provider.id,
                            () =>
                              api(`/api/admin/providers/${provider.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({
                                  enabled: !provider.enabled,
                                  ...(provider.enabled ? { isDefault: false } : {}),
                                }),
                              }),
                            provider.enabled ? '接口已停用。' : '接口已启用。',
                          )
                        }
                      >
                        {provider.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        className="button button-secondary"
                        disabled={!!busy || !provider.hasApiKey || !provider.enabled}
                        onClick={() => void testProvider(provider)}
                      >
                        {busy === provider.id ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <Activity size={15} />
                        )}
                        {busy === provider.id ? '处理中…' : '测试连接'}
                      </button>
                    </div>
                  </footer>
                </article>
              ))}
            </div>
          )}
          <p className="admin-bottom-note">
            连接测试会发送一个简短请求，可能产生少量模型调用费用。
          </p>
        </section>
      )}

      {tab === 'users' && (
        <UserDirectory
          currentUser={user}
          revision={auditRevision}
          onChanged={() => void refresh()}
        />
      )}

      {tab === 'settings' && <SiteSettings />}
      {tab === 'audit' && <RequestAudit refreshVersion={auditRevision} />}
      {tab === 'announcements' && <AnnouncementManager refreshVersion={auditRevision} />}
      {characterEditor !== undefined && (
        <CharacterEditor
          character={characterEditor}
          onClose={() => setCharacterEditor(undefined)}
          onSaved={() => saved('character')}
        />
      )}
      {providerEditor !== undefined && (
        <ProviderEditor
          provider={providerEditor}
          onClose={() => setProviderEditor(undefined)}
          onSaved={() => saved('provider')}
        />
      )}
      {deletion && (
        <Dialog
          title={deletion.kind === 'characters' ? '确认删除角色' : '确认删除模型接口'}
          onClose={() => setDeletion(null)}
          busy={!!busy}
        >
          <div className="admin-confirm-body">
            <p>
              确定删除「<strong>{deletion.name}</strong>」吗？
            </p>
            <p className="muted">
              {deletion.kind === 'characters'
                ? '这项操作无法撤销。如果只是暂时停止新对话，建议选择下架。'
                : '这项操作无法撤销。使用此接口的对话需要切换到其他可用模型。'}
            </p>
          </div>
          <footer className="admin-dialog-footer">
            <div>
              <button className="button button-secondary" data-dialog-close disabled={!!busy}>
                保留
              </button>
              <button
                className="button admin-danger-button"
                onClick={() => void confirmDelete()}
                disabled={!!busy}
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}确认删除
              </button>
            </div>
          </footer>
        </Dialog>
      )}
    </div>
  );
}
