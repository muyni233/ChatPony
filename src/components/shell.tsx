'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bell,
  BookHeart,
  ChevronRight,
  Compass,
  House,
  IdCard,
  LibraryBig,
  LogIn,
  LogOut,
  Menu,
  MessageCircle,
  Monitor,
  Moon,
  Plus,
  Settings2,
  ShieldCheck,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useApp, type ThemePreference } from './app-provider';
import { AuthDialog } from './auth-dialog';
import { NewChat } from './new-chat';
import { Avatar, Button, IconButton } from './ui';
import { api, json } from '@/lib/client';
import { prefetchConversation } from '@/lib/conversation-cache';
import { useToday } from '@/lib/use-today';

const nav = [
  { href: '/', label: '首页', icon: House },
  { href: '/characters', label: '角色广场', icon: Compass },
  { href: '/my-characters', label: '我的角色', icon: LibraryBig },
  { href: '/conversations', label: '对话', icon: MessageCircle },
  { href: '/memories', label: '记忆', icon: BookHeart },
  { href: '/persona', label: '人设', icon: IdCard },
];
const pageTitles: Record<string, string> = {
  '/admin': '管理后台',
  '/announcements': '公告',
  '/settings': '设置',
};
const themeCycle: ThemePreference[] = ['system', 'light', 'dark'];
const themeLabels: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data, openAuth, refresh, notify, error, theme, setTheme } = useApp();
  const [mobile, setMobile] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const isChat = pathname.startsWith('/chat/');
  const chatId = isChat ? pathname.split('/')[2] : '';
  const currentConversation = data?.conversations.find((c) => c.id === chatId);
  const title = isChat
    ? currentConversation?.title || '对话'
    : pageTitles[pathname] || nav.find((n) => n.href === pathname)?.label || 'ChatPony';
  const section = isChat ? { label: '对话', href: '/conversations' } : null;
  const active = (href: string) =>
    href === '/conversations' ? pathname === href || isChat : pathname === href;

  useEffect(() => {
    const query = window.matchMedia('(max-width: 980px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  // Close the mobile drawer on navigation and with Escape; keep focus sensible.
  useEffect(() => {
    setMobile(false);
  }, [pathname]);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebar.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobile(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [mobile]);

  function begin() {
    setMobile(false);
    if (!data?.user) openAuth();
    else setNewChat(true);
  }
  async function logout() {
    try {
      await api('/auth/logout', json('POST'));
      await refresh();
      router.push('/');
      notify('已退出登录。');
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }
  const nextTheme = themeCycle[(themeCycle.indexOf(theme) + 1) % themeCycle.length];
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const recent = data?.user ? data.conversations.slice(0, 5) : [];
  const quota = data?.quota?.fiveHour;
  const quotaPercent =
    quota && quota.limit > 0 ? Math.min(100, Math.round((quota.remaining / quota.limit) * 100)) : 0;

  return (
    <div className="app-shell">
      <div
        className={`sidebar-scrim ${mobile ? 'sidebar-scrim-visible' : ''}`}
        onClick={() => setMobile(false)}
        aria-hidden="true"
      />
      <aside
        ref={sidebar}
        className={`sidebar ${mobile ? 'sidebar-open' : ''}`}
        aria-label="侧边栏"
        id="app-sidebar"
        inert={narrow && !mobile}
      >
        <div className="sidebar-header">
          <Link className="brand" href="/" aria-label="ChatPony 首页">
            <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                fillRule="evenodd"
                d="M8 49V31A24 24 0 0 1 56 31V49a3 3 0 0 1-3 3H46a3 3 0 0 1-3-3V31A11 11 0 0 0 21 31V50L10.6 58.4A1.6 1.6 0 0 1 8 57.2ZM12.6 41a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0ZM13.7 28.5a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0ZM19.7 18.2a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0ZM40.5 18.2a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0ZM46.5 28.5a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0ZM47.6 41a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0Z"
              />
            </svg>
            <span className="brand-name">
              Chat<span className="brand-pony">Pony</span>
            </span>
          </Link>
          <button
            className="mobile-close icon-button icon-button-sm"
            aria-label="关闭导航"
            onClick={() => {
              setMobile(false);
              menuButton.current?.focus();
            }}
          >
            <X size={18} />
          </button>
        </div>
        <div className="sidebar-scroll">
          <Button className="new-chat-button" onClick={begin}>
            <Plus size={17} />
            新建对话
          </Button>
          <div className="nav-section">
            <nav className="main-nav" aria-label="主导航">
              {nav.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`nav-item ${active(n.href) ? 'active' : ''}`}
                  aria-current={active(n.href) ? 'page' : undefined}
                >
                  <n.icon size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-text">{n.label}</span>
                  {n.href === '/conversations' && !!data?.conversations.length && (
                    <span className="nav-count" aria-label={`${data.conversations.length} 个对话`}>
                      {data.conversations.length}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          </div>
          {!!recent.length && (
            <div className="nav-section">
              <div className="nav-label">最近对话</div>
              <ul className="recent-nav" aria-label="最近对话">
                {recent.map((c) => {
                  const character = data?.characters.find((ch) => ch.id === c.characterIds[0]);
                  const current = chatId === c.id;
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/chat/${c.id}`}
                        onMouseEnter={() => prefetchConversation(data?.user?.id, c.id)}
                        onFocus={() => prefetchConversation(data?.user?.id, c.id)}
                        onTouchStart={() => prefetchConversation(data?.user?.id, c.id)}
                        className={`recent-nav-item ${current ? 'active' : ''}`}
                        aria-current={current ? 'page' : undefined}
                        title={c.title}
                      >
                        {c.kind === 'group' ? (
                          <span className="recent-nav-icon" aria-hidden="true">
                            <Users size={12} />
                          </span>
                        ) : (
                          <Avatar
                            name={character?.name || c.title}
                            src={character?.avatar}
                            color={character?.color}
                            size="xs"
                          />
                        )}
                        <span className="recent-nav-title">{c.title}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="nav-section">
            <nav className="main-nav" aria-label="其他导航">
              <Link
                href="/announcements"
                className={`nav-item ${pathname === '/announcements' ? 'active' : ''}`}
                aria-current={pathname === '/announcements' ? 'page' : undefined}
              >
                <Bell size={17} strokeWidth={1.8} aria-hidden="true" />
                <span className="nav-text">公告</span>
                {!!data?.announcements.length && (
                  <span className="notification-dot" aria-label="有新公告" />
                )}
              </Link>
              <Link
                href="/settings"
                className={`nav-item ${pathname === '/settings' ? 'active' : ''}`}
                aria-current={pathname === '/settings' ? 'page' : undefined}
              >
                <Settings2 size={17} strokeWidth={1.8} aria-hidden="true" />
                <span className="nav-text">设置</span>
              </Link>
              {data?.user?.role === 'admin' && (
                <Link
                  href="/admin"
                  className={`nav-item ${pathname === '/admin' ? 'active' : ''}`}
                  aria-current={pathname === '/admin' ? 'page' : undefined}
                >
                  <ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-text">管理后台</span>
                </Link>
              )}
            </nav>
          </div>
        </div>
        <div className="sidebar-footer">
          {data?.user && quota && (
            <Link href="/settings" className="sidebar-usage">
              <span className="sidebar-usage-row">
                <span>5 小时剩余</span>
                <strong>
                  {quota.remaining}
                  <small> / {quota.limit}</small>
                </strong>
              </span>
              <span className="sidebar-usage-track" aria-hidden="true">
                <span style={{ width: `${quotaPercent}%` }} />
              </span>
            </Link>
          )}
          <div className="account-block">
            {data?.user ? (
              <>
                <Link className="account-link" href="/settings">
                  <Avatar name={data.user.name} src={data.user.avatar} size="small" />
                  <span className="account-meta">
                    <strong>{data.user.name}</strong>
                    <small>{data.user.role === 'admin' ? '管理员' : data.user.email}</small>
                  </span>
                </Link>
                <IconButton
                  label="退出登录"
                  className="logout-button"
                  tooltipSide="top"
                  onClick={logout}
                >
                  <LogOut size={16} />
                </IconButton>
              </>
            ) : (
              <button className="account-link" onClick={() => openAuth()}>
                <span className="guest-avatar" aria-hidden="true">
                  <LogIn size={16} />
                </span>
                <span className="account-meta">
                  <strong>未登录</strong>
                  <small>登录 / 注册</small>
                </span>
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="topbar-left">
            <button
              ref={menuButton}
              aria-label="打开导航"
              aria-expanded={mobile}
              aria-controls="app-sidebar"
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <nav className="breadcrumb" aria-label="当前位置">
              <ol>
                {section && (
                  <>
                    <li className="breadcrumb-section">
                      <Link href={section.href}>{section.label}</Link>
                    </li>
                    <li aria-hidden="true" className="breadcrumb-separator">
                      <ChevronRight size={14} />
                    </li>
                  </>
                )}
                <li>
                  <strong aria-current="page">{title}</strong>
                </li>
              </ol>
            </nav>
          </div>
          <div className="topbar-actions">
            <span className="topbar-date">
              <ClientDate />
            </span>
            <IconButton
              label={`主题：${themeLabels[theme]}（切换为${themeLabels[nextTheme]}）`}
              tooltipSide="bottom"
              onClick={() => setTheme(nextTheme)}
              className="theme-toggle"
            >
              <ThemeIcon size={17} />
            </IconButton>
            <Link
              href="/announcements"
              className="icon-button topbar-bell"
              aria-label="公告"
              data-tooltip="公告"
              data-tooltip-side="bottom"
            >
              <Bell size={17} />
              {!!data?.announcements.length && <span className="bell-dot" aria-hidden="true" />}
            </Link>
            {!data?.user && (
              <Button size="sm" className="login-top" onClick={() => openAuth()}>
                登录 / 注册
              </Button>
            )}
            {data?.user && (
              <Link href="/settings" aria-label="设置" className="topbar-avatar">
                <Avatar name={data.user.name} src={data.user.avatar} size="small" />
              </Link>
            )}
          </div>
        </header>
        {error && (
          <div className="connection-banner" role="alert">
            <span>{error}</span>
            <button className="text-button" onClick={refresh}>
              重新连接
            </button>
          </div>
        )}
        <main className={`main-content ${isChat ? 'main-chat' : ''}`} id="main-content">
          {children}
        </main>
        {!isChat && (
          <footer className="page-footer">
            <span>© ChatPony</span>
            <span>角色回复由 AI 生成</span>
          </footer>
        )}
      </div>
      <AuthDialog />
      {newChat && <NewChat open onClose={() => setNewChat(false)} />}
    </div>
  );
}
function ClientDate() {
  const date = useToday();
  return (
    <span>
      {date?.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }) ||
        '今天'}
    </span>
  );
}
