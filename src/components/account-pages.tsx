'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Bell,
  Check,
  Clock3,
  Eye,
  KeyRound,
  LogOut,
  Pin,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useApp } from './app-provider';
import { Avatar, Badge, Button, EmptyState, Field, Modal, Select } from './ui';
import { AuthRequired, Loading, PageHeading } from './library';
import { QuotaCard } from './quota-card';
import { AvatarEditorButton } from './avatar-editor';
import './persona.css';
import { api, dateLabel, json } from '@/lib/client';
import type { Announcement } from '@/lib/types';

export function AnnouncementsPage() {
  const { data, loading } = useApp();
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [error, setError] = useState('');
  async function load() {
    try {
      setAnnouncements(await api<Announcement[]>('/announcements'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const items = announcements || data?.announcements || [];
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="NEWS & LITTLE UPDATES"
        title="公告中心"
        description="平台的新消息、功能更新与运营通知，都在这里。"
      />
      {error && (
        <div className="form-error" role="alert">
          {error}{' '}
          <button className="text-button" onClick={load}>
            重试
          </button>
        </div>
      )}
      {loading ? (
        <Loading />
      ) : items.length ? (
        <div className="announcement-list">
          {items.map((a) => (
            <article key={a.id} className="paper-card announcement-card">
              <div className="announcement-meta">
                <Badge tone={a.pinned ? 'pink' : 'green'}>
                  {a.pinned ? (
                    <>
                      <Pin size={11} />
                      置顶公告
                    </>
                  ) : (
                    '平台动态'
                  )}
                </Badge>
                <time>
                  {dateLabel(a.createdAt, { year: 'numeric', month: 'long', day: 'numeric' })}
                </time>
              </div>
              <h2>{a.title}</h2>
              <p>{a.content}</p>
            </article>
          ))}
        </div>
      ) : (
        <div className="paper-card">
          <EmptyState
            icon={<Bell size={27} />}
            title="暂时没有新的公告"
            description="平台发布的通知与更新将展示在这里。你可以稍后再来看看。"
          />
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { data, loading, refresh, notify } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [reduced, setReduced] = useState(false);
  const passwordForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    setReduced(localStorage.getItem('chatpony-reduced-motion') === 'true');
  }, []);
  const user = data?.user;
  async function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy('profile');
    setError('');
    try {
      await api('/account', json('PATCH', Object.fromEntries(new FormData(e.currentTarget))));
      await refresh();
      notify('个人资料已更新。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get('password') !== form.get('confirmPassword')) {
      notify('两次输入的新密码不一致。', 'error');
      return;
    }
    setBusy('password');
    try {
      await api(
        '/account',
        json('PATCH', {
          currentPassword: form.get('currentPassword'),
          password: form.get('password'),
        }),
      );
      passwordForm.current?.reset();
      await refresh();
      notify('密码已更新。其他设备的登录会话已失效。');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }
  async function logout() {
    setBusy('logout');
    try {
      await api('/auth/logout', json('POST'));
      await refresh();
      setLogoutOpen(false);
      router.push('/');
      notify('已安全退出登录。');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }
  function toggleMotion(value: boolean) {
    setReduced(value);
    localStorage.setItem('chatpony-reduced-motion', String(value));
    document.documentElement.dataset.reduceMotion = String(value);
  }
  const timezones = [
    'Asia/Shanghai',
    'Asia/Hong_Kong',
    'Asia/Taipei',
    'Asia/Tokyo',
    'Asia/Singapore',
    'Asia/Seoul',
    'Europe/London',
    'Europe/Paris',
    'America/New_York',
    'America/Los_Angeles',
    'Australia/Sydney',
    'UTC',
  ];
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="MAKE YOURSELF AT HOME"
        title="账户设置"
        description="调整个人资料、管理账户安全，查看你的使用额度。"
      />
      {loading ? (
        <Loading />
      ) : !user ? (
        <AuthRequired title="登录后，管理你的账户" />
      ) : (
        <div className="settings-grid">
          <div className="settings-main">
            <section className="paper-card settings-card">
              <h2>
                <UserRound size={19} />
                个人资料
              </h2>
              <div className="settings-profile">
                <Avatar name={user.name} src={user.avatar} size="large" />
                <div>
                  <strong>{user.name}</strong>
                  <p>{user.email}</p>
                  <Badge tone="green">{user.role === 'admin' ? '平台管理员' : '已注册用户'}</Badge>
                  {user.emailVerifiedAt && (
                    <Badge tone="green">
                      <Check size={11} />
                      邮箱已验证
                    </Badge>
                  )}
                </div>
                <AvatarEditorButton />
              </div>
              <form
                className="form-stack"
                onSubmit={saveProfile}
                key={user.id + user.name + user.timezone}
              >
                <Field label="昵称">
                  <input
                    name="name"
                    required
                    minLength={1}
                    maxLength={60}
                    defaultValue={user.name}
                    autoComplete="nickname"
                  />
                </Field>
                <Field label="邮箱">
                  <input type="email" disabled value={user.email} readOnly />
                </Field>
                <Field label="时区" hint="角色会根据这个时区获知当地日期、时间、节日与节气。">
                  <Select name="timezone" defaultValue={user.timezone}>
                    {!timezones.includes(user.timezone) && <option>{user.timezone}</option>}
                    {timezones.map((tz) => (
                      <option key={tz}>{tz}</option>
                    ))}
                  </Select>
                </Field>
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <Button type="submit" loading={busy === 'profile'} disabled={!!busy}>
                  <Check size={16} />
                  保存资料
                </Button>
              </form>
            </section>
            <section className="paper-card settings-card">
              <h2>
                <KeyRound size={19} />
                修改密码
              </h2>
              <form className="form-stack" ref={passwordForm} onSubmit={changePassword}>
                <Field label="当前密码">
                  <input
                    type="password"
                    name="currentPassword"
                    required
                    maxLength={128}
                    autoComplete="current-password"
                  />
                </Field>
                <div className="form-grid">
                  <Field label="新密码" hint="至少 10 个字符。">
                    <input
                      type="password"
                      name="password"
                      minLength={10}
                      maxLength={128}
                      required
                      autoComplete="new-password"
                    />
                  </Field>
                  <Field label="确认新密码">
                    <input
                      type="password"
                      name="confirmPassword"
                      minLength={10}
                      maxLength={128}
                      required
                      autoComplete="new-password"
                    />
                  </Field>
                </div>
                <Button
                  type="submit"
                  variant="secondary"
                  loading={busy === 'password'}
                  disabled={!!busy}
                >
                  <ShieldCheck size={16} />
                  更新密码
                </Button>
              </form>
            </section>
            <section className="paper-card settings-card">
              <h2>
                <Eye size={19} />
                显示偏好
              </h2>
              <label className="toggle-row">
                <span>
                  减少动态效果
                  <small>关闭位移动画与装饰动效，系统的减少动态效果设置同样生效。</small>
                </span>
                <input
                  type="checkbox"
                  checked={reduced}
                  onChange={(e) => toggleMotion(e.target.checked)}
                />
              </label>
            </section>
            <section className="paper-card settings-card danger-zone">
              <h2>
                <LogOut size={18} />
                退出登录
              </h2>
              <p className="field-hint">退出后，你的对话和记忆会继续安全保存在账户中。</p>
              <Button variant="secondary" onClick={() => setLogoutOpen(true)}>
                退出当前账户
              </Button>
            </section>
          </div>
          <aside className="settings-side">
            <QuotaCard expanded />
            <section className="paper-card settings-card">
              <h2>
                <Clock3 size={18} />
                在这里的记录
              </h2>
              <div className="settings-stat">
                <span>加入时间</span>
                <strong>{dateLabel(user.createdAt)}</strong>
              </div>
              <div className="settings-stat">
                <span>对话数量</span>
                <strong>{data.stats.conversations} 段</strong>
              </div>
              <div className="settings-stat">
                <span>消息数量</span>
                <strong>{data.stats.messages} 条</strong>
              </div>
              <div className="settings-stat">
                <span>长期记忆</span>
                <strong>{data.stats.memories} 条</strong>
              </div>
              <p className="section-note">
                对话记录可以在对话页面导出。记忆可在「长期记忆」中单独管理。
              </p>
            </section>
          </aside>
        </div>
      )}
      <Modal
        open={logoutOpen}
        onClose={() => !busy && setLogoutOpen(false)}
        title="退出当前账户？"
        description="已保存的对话与记忆将保留，下次登录后可以继续。"
      >
        <div className="modal-actions">
          <Button variant="secondary" disabled={!!busy} onClick={() => setLogoutOpen(false)}>
            取消
          </Button>
          <Button loading={busy === 'logout'} onClick={logout}>
            退出登录
          </Button>
        </div>
      </Modal>
    </div>
  );
}
