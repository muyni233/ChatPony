'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Compass,
  MessagesSquare,
  UsersRound,
  Bookmark,
  Megaphone,
  Settings2,
  ArrowUpRight,
  Plus,
  PanelLeftClose,
  Menu,
  BookOpen,
  ShieldCheck,
  ChevronRight,
  MessageCircle,
  X,
} from 'lucide-react';
import { useSession } from './session-provider';
import { BrandMark, Modal, Spinner } from './ui';
import { api } from '@/lib/client';
import type { Conversation } from '@/lib/types';

const navigation = [
  { href: '/', label: '发现', english: 'Discover', icon: Compass },
  { href: '/conversations', label: '我的对话', english: 'Conversations', icon: MessagesSquare },
  { href: '/groups', label: '群聊空间', english: 'Group chats', icon: UsersRound },
  { href: '/memories', label: '记忆档案', english: 'Memories', icon: Bookmark },
  { href: '/announcements', label: '站点公告', english: 'Announcements', icon: Megaphone },
];
export function AppShell({
  children,
  preview = false,
}: {
  children: React.ReactNode;
  preview?: boolean;
}) {
  const { user, site, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [recent, setRecent] = useState<Conversation[]>([]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [announcements, setAnnouncements] = useState<{
    userId: string;
    unreadCount: number;
  } | null>(null);
  const unreadRequest = useRef(0);
  const sidebarRef = useRef<HTMLElement>(null);
  const userId = user?.id;
  const unreadCount = announcements?.userId === userId ? (announcements?.unreadCount ?? 0) : 0;
  const loadUnread = useCallback(() => {
    if (!userId || document.visibilityState === 'hidden') return;
    const sequence = ++unreadRequest.current;
    return api<{ unreadCount: number }>('/api/announcements/unread')
      .then((data) => {
        if (sequence === unreadRequest.current)
          setAnnouncements({ userId, unreadCount: data.unreadCount });
      })
      .catch(() => {
        /* Keep the last known badge on temporary network failures. */
      });
  }, [userId]);
  useEffect(() => {
    void loadUnread();
  }, [loadUnread, pathname]);
  useEffect(() => {
    const update = () => {
      void loadUnread();
    };
    window.addEventListener('chatpony:announcements', update);
    document.addEventListener('visibilitychange', update);
    const timer = window.setInterval(update, 120000);
    return () => {
      window.removeEventListener('chatpony:announcements', update);
      document.removeEventListener('visibilitychange', update);
      window.clearInterval(timer);
    };
  }, [loadUnread]);
  useEffect(() => {
    if (!preview && !loading && !user) router.replace('/login');
  }, [loading, user, router, preview]);
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const items = () =>
      Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)') || [],
      ).filter(
        (element) =>
          element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden',
      );
    items()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
      if (event.key === 'Tab') {
        const list = items();
        const first = list[0];
        const last = list[list.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [mobileOpen]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const onChange = () => {
      if (!query.matches) setMobileOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const loadRecent = useCallback(() => {
    if (!user) return Promise.resolve();
    return api<{ conversations: Conversation[] }>('/api/conversations')
      .then((data) => setRecent(data.conversations.slice(0, 4)))
      .catch(() => setRecent([]));
  }, [user]);
  useEffect(() => {
    void loadRecent();
  }, [loadRecent, pathname]);
  useEffect(() => {
    const handler = () => void loadRecent();
    window.addEventListener('chatpony:conversations', handler);
    return () => window.removeEventListener('chatpony:conversations', handler);
  }, [loadRecent]);
  const homeHref = preview && !user ? '/preview' : '/';
  const currentPath = pathname === '/preview' ? '/' : pathname;
  const current =
    navigation.find((item) => item.href === currentPath) ||
    (pathname.startsWith('/chat/')
      ? { label: '对话', english: 'Conversation' }
      : pathname.startsWith('/admin')
        ? { label: '管理后台', english: 'Workspace' }
        : { label: '账号设置', english: 'Settings' });
  if (loading || (!preview && !user))
    return (
      <div className="session-loading">
        <Spinner label="正在确认登录状态…" />
      </div>
    );
  return (
    <div className="app-shell">
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        aria-label="ChatPony 导航"
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen || undefined}
        className={`sidebar ${mobileOpen ? 'is-open' : ''}`}
      >
        <div className="sidebar-brand">
          <Link href={homeHref} className="brand" onClick={() => setMobileOpen(false)}>
            <BrandMark />
            <span>
              {site?.name || 'ChatPony'}
              <span className="brand-subtitle">a little magic, every day.</span>
            </span>
          </Link>
          <button
            className="icon-button sidebar-close"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <Link href={homeHref} className="new-chat-button" onClick={() => setMobileOpen(false)}>
          <Plus size={17} />
          <span>开启新对话</span>
          <span className="new-chat-shortcut">↗</span>
        </Link>
        <div className="nav-caption">
          你的故事空间 <span>YOUR SPACE</span>
        </div>
        <nav aria-label="主要导航" className="main-nav">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href === '/' ? homeHref : href}
              onClick={() => setMobileOpen(false)}
              className={`nav-item ${currentPath === href || (href === '/conversations' && pathname.startsWith('/chat/')) ? 'active' : ''}`}
            >
              <Icon size={19} strokeWidth={1.6} />
              <span>{label}</span>
              {href === '/' && <span className="nav-spark">✦</span>}
              {href === '/announcements' && unreadCount > 0 && (
                <span className="nav-announcement-badge" aria-label={`${unreadCount} 条未读公告`}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="recent-section">
          <div className="nav-caption">
            最近对话 <span>RECENT</span>
          </div>
          {user && recent.length ? (
            <div className="recent-list">
              {recent.map((item) => (
                <Link
                  key={item.id}
                  href={`/chat/${item.id}`}
                  className={`recent-item ${pathname.endsWith(item.id) ? 'selected' : ''}`}
                  onClick={() => setMobileOpen(false)}
                >
                  <MessageCircle size={14} />
                  <span>{item.title}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="recent-empty">
              <span className="tiny-star">✳</span>
              <p>
                第一声「你好」，
                <br />
                会让这里热闹起来。
              </p>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className="guide-card"
            onClick={() => {
              setMobileOpen(false);
              setHelp(true);
            }}
          >
            <div>
              <BookOpen size={17} />
              <span>初次来到这里？</span>
              <ArrowUpRight size={15} />
            </div>
            <p>一份小小的使用指南</p>
            <span className="guide-dots" aria-hidden="true">
              ···································
            </span>
          </button>
          {user?.role === 'admin' && (
            <Link href="/admin" className="sidebar-settings">
              <ShieldCheck size={17} /> 管理后台
              <ChevronRight size={15} />
            </Link>
          )}
          <Link href={user ? '/settings' : '/login'} className="profile-link">
            <span className="profile-avatar">{user?.username.slice(0, 1) || <SparkleMark />}</span>
            <span>
              <strong>{user?.username || '你好，新朋友'}</strong>
              <small>{user ? '账号与偏好设置' : '登录，让故事继续'}</small>
            </span>
            {user ? <Settings2 size={17} /> : <ArrowUpRight size={17} />}
          </Link>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-expanded={mobileOpen}
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb-home">{preview && !user ? '访客预览' : '我的空间'}</span>
            <ChevronRight size={12} />
            <strong>{current.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="quiet-tag">
              <span /> 留一点时间，给想象力
            </span>
            <span className="topbar-divider" />
            <button className="icon-button" onClick={() => setHelp(true)} aria-label="使用指南">
              <BookOpen size={18} />
            </button>
            {!user && (
              <Link href="/login" className="topbar-login">
                登录 <ArrowUpRight size={14} />
              </Link>
            )}
          </div>
        </header>
        <main
          className={pathname.startsWith('/chat/') ? 'main-content chat-content' : 'main-content'}
          key={pathname}
        >
          {children}
        </main>
        <footer className="site-footer">
          <span>
            ChatPony <span className="footer-star">✦</span> A space for stories & friendship.
          </span>
          <span>由想象力连接彼此</span>
        </footer>
      </div>
      {help && (
        <Modal title="欢迎来到 ChatPony" onClose={() => setHelp(false)}>
          <div className="guide-content">
            <p>这是一个以《小马宝莉》为主题的 AI 角色扮演对话平台。角色由平台管理员创建与发布。</p>
            <ol>
              <li>
                <strong>认识一位新朋友</strong>
                <p>在「发现」中选择角色，开始一对一的对话。</p>
              </li>
              <li>
                <strong>邀请大家一起聊聊</strong>
                <p>
                  在「群聊空间」选择 2–6 位角色，设定场景。用 @ 邀请指定角色回应；角色也可以 @
                  彼此接话，每次自动接话有明确上限。
                </p>
              </li>
              <li>
                <strong>留下值得记住的事</strong>
                <p>
                  在「记忆档案」管理每位角色可以记住的偏好与背景。这些记忆会用于你之后与该角色的对话。
                </p>
              </li>
            </ol>
            <p className="notice">
              对话由 AI 生成，可能出现虚构或不准确的内容。ChatPony 是非官方同人项目，与 Hasbro
              没有关联。
            </p>
          </div>
          <button className="button button-primary full-width" onClick={() => setHelp(false)}>
            准备好了 <X size={15} />
          </button>
        </Modal>
      )}
    </div>
  );
}
function SparkleMark() {
  return <span aria-hidden="true">✦</span>;
}
