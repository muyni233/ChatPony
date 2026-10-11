'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Bell,
  BookHeart,
  CalendarDays,
  ChevronDown,
  Compass,
  Heart,
  House,
  IdCard,
  LogOut,
  Menu,
  MessageCircle,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useApp } from './app-provider';
import { AuthDialog } from './auth-dialog';
import { NewChat } from './new-chat';
import { Avatar, Button } from './ui';
import { api, json } from '@/lib/client';
import { useToday } from '@/lib/use-today';

const nav = [
  { href: '/', label: '概览', icon: House },
  { href: '/characters', label: '角色广场', icon: Compass },
  { href: '/conversations', label: '我的对话', icon: MessageCircle },
  { href: '/memories', label: '长期记忆', icon: BookHeart },
  { href: '/persona', label: '我的自设', icon: IdCard },
];
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data, openAuth, refresh, notify, error } = useApp();
  const [mobile, setMobile] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const title = pathname.startsWith('/chat/')
    ? '对话空间'
    : pathname === '/admin'
      ? '管理后台'
      : pathname === '/announcements'
        ? '公告中心'
        : pathname === '/settings'
          ? '账户设置'
          : nav.find((n) => n.href === pathname)?.label || 'ChatPony';
  const active = (href: string) =>
    href === '/conversations'
      ? pathname === href || pathname.startsWith('/chat/')
      : pathname === href;
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
  return (
    <div className="app-shell">
      {mobile && (
        <button className="sidebar-scrim" onClick={() => setMobile(false)} aria-label="关闭导航" />
      )}
      <aside className={`sidebar ${mobile ? 'sidebar-open' : ''}`}>
        <Link className="brand" href="/" onClick={() => setMobile(false)}>
          <span className="brand-mark">
            <Sparkles size={26} strokeWidth={1.6} />
          </span>
          <span>
            Chat<span className="brand-pony">Pony</span>
            <small>A LITTLE MORE MAGIC</small>
          </span>
        </Link>
        <button
          className="mobile-close icon-button"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        >
          <X size={20} />
        </button>
        <Button className="new-chat-button" onClick={begin}>
          <Plus size={19} />
          开启新对话
        </Button>
        <div className="nav-label">
          你的空间 <span>YOUR SPACE</span>
        </div>
        <nav className="main-nav" aria-label="主导航">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setMobile(false)}
              className={`nav-item ${active(n.href) ? 'active' : ''}`}
              aria-current={active(n.href) ? 'page' : undefined}
            >
              <n.icon size={19} strokeWidth={1.7} />
              {n.label}
              {n.href === '/conversations' && !!data?.conversations.length && (
                <span className="nav-count">{data.conversations.length}</span>
              )}
              {active(n.href) && <span className="active-dot" />}
            </Link>
          ))}
        </nav>
        <div className="nav-divider" />
        <nav className="main-nav" aria-label="平台导航">
          <Link
            href="/announcements"
            onClick={() => setMobile(false)}
            className={`nav-item ${pathname === '/announcements' ? 'active' : ''}`}
          >
            <Bell size={19} strokeWidth={1.7} />
            公告中心{!!data?.announcements.length && <span className="notification-dot" />}
          </Link>
          <Link
            href="/settings"
            onClick={() => setMobile(false)}
            className={`nav-item ${pathname === '/settings' ? 'active' : ''}`}
          >
            <Settings2 size={19} strokeWidth={1.7} />
            账户设置
          </Link>
          {data?.user?.role === 'admin' && (
            <Link
              href="/admin"
              onClick={() => setMobile(false)}
              className={`nav-item ${pathname === '/admin' ? 'active' : ''}`}
            >
              <ShieldCheck size={19} strokeWidth={1.7} />
              管理后台
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="tape tape-mint" />
            <Heart size={18} strokeWidth={1.5} />
            <p>
              每一个故事，
              <br />
              都始于一次相遇。
            </p>
            <span className="note-signature">Friendship is magic.</span>
            <Sparkles className="note-spark" size={24} strokeWidth={1.2} />
          </div>
          <div className="account-block">
            {data?.user ? (
              <>
                <button
                  className="account-link"
                  onClick={() => {
                    router.push('/settings');
                    setMobile(false);
                  }}
                >
                  <Avatar name={data.user.name} src={data.user.avatar} size="small" />
                  <span>
                    <strong>{data.user.name}</strong>
                    <small>{data.user.role === 'admin' ? '平台管理员' : '故事的同行者'}</small>
                  </span>
                  <ChevronDown size={15} />
                </button>
                <button
                  className="icon-button logout-button"
                  onClick={logout}
                  title="退出登录"
                  aria-label="退出登录"
                >
                  <LogOut size={16} />
                </button>
              </>
            ) : (
              <button className="account-link" onClick={() => openAuth()}>
                <span className="guest-avatar">访</span>
                <span>
                  <strong>欢迎，旅行者</strong>
                  <small>登录，让故事继续</small>
                </span>
                <ArrowUpRight size={17} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              aria-label="打开导航"
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
            >
              <Menu size={21} />
            </button>
            <span>我的工作台</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <span className="topbar-date">
              <CalendarDays size={15} />
              <ClientDate />
            </span>
            <span className="topbar-separator" />
            <Link href="/announcements" className="icon-button" aria-label="查看平台公告">
              <Bell size={18} />
            </Link>
            {!data?.user && (
              <Button variant="secondary" className="login-top" onClick={() => openAuth()}>
                登录 / 注册
                <ArrowUpRight size={14} />
              </Button>
            )}
            {data?.user && (
              <Link href="/settings" aria-label="账户设置">
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
        <main
          className={`main-content ${pathname.startsWith('/chat/') ? 'main-chat' : ''}`}
          id="main-content"
        >
          {children}
        </main>
        {!pathname.startsWith('/chat/') && (
          <footer className="page-footer">
            <span>
              <Sparkles size={13} />
              ChatPony · 让友谊发生
            </span>
            <span>
              Made for the magic of friendship <Heart size={11} />
            </span>
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
      {date?.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) ||
        '今天'}
    </span>
  );
}
