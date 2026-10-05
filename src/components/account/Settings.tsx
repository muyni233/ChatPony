'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  Check,
  KeyRound,
  LoaderCircle,
  LogOut,
  Mail,
  NotebookPen,
  ShieldCheck,
  Trash2,
  UserRound,
} from 'lucide-react';
import { api } from '@/lib/client';
import type { User } from '@/lib/types';
import { PasswordInput } from './AuthForm';
import Dialog from '@/components/admin/Dialog';
import QuotaCard from './QuotaCard';

export default function Settings() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState({ section: '', message: '' });
  const [success, setSuccess] = useState({ section: '', message: '' });
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ user: User | null }>('/api/session')
      .then((result) => {
        if (active) setUser(result.user);
      })
      .catch((cause) => {
        if (active) setLoadError(cause instanceof Error ? cause.message : '账户信息加载失败。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(
    event: FormEvent<HTMLFormElement>,
    section: 'profile' | 'password' | 'email',
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setError({ section: '', message: '' });
    setSuccess({ section: '', message: '' });
    if (section === 'password' && values.get('newPassword') !== values.get('confirmPassword')) {
      setError({ section, message: '两次输入的新密码不一致。' });
      return;
    }
    setBusy(section);
    try {
      if (section === 'password') {
        await api('/api/auth/password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: values.get('currentPassword'),
            newPassword: values.get('newPassword'),
          }),
        });
        form.reset();
      } else {
        const result = await api<{ user: User; verificationRequired?: boolean; message?: string }>(
          '/api/profile',
          {
            method: 'PATCH',
            body: JSON.stringify(
              section === 'profile'
                ? { username: String(values.get('username') ?? '').trim() }
                : {
                    email: String(values.get('email') ?? '').trim(),
                    currentPassword: values.get('currentPassword'),
                  },
            ),
          },
        );
        setUser(result.user);
        window.dispatchEvent(new Event('chatpony:session'));
        if (result.verificationRequired) {
          setSuccess({
            section,
            message: result.message || '验证邮件已发送至新邮箱。完成验证前，你仍可使用原邮箱登录。',
          });
          return;
        }
      }
      setSuccess({
        section,
        message:
          section === 'password'
            ? '密码已更新，其他设备上的登录状态已失效。'
            : section === 'email'
              ? '登录邮箱已更新。'
              : '昵称已保存。',
      });
    } catch (cause) {
      setError({ section, message: cause instanceof Error ? cause.message : '保存失败，请重试。' });
    } finally {
      setBusy('');
    }
  }

  async function logout() {
    setBusy('logout');
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      window.dispatchEvent(new Event('chatpony:session'));
      router.push('/login');
      router.refresh();
    } catch (cause) {
      setError({
        section: 'logout',
        message: cause instanceof Error ? cause.message : '退出失败，请重试。',
      });
      setBusy('');
    }
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy('delete');
    setError({ section: '', message: '' });
    try {
      await api('/api/profile', {
        method: 'DELETE',
        body: JSON.stringify({ password: data.get('password') }),
      });
      window.dispatchEvent(new Event('chatpony:session'));
      router.push('/');
      router.refresh();
    } catch (cause) {
      setError({
        section: 'delete',
        message: cause instanceof Error ? cause.message : '注销失败，请稍后重试。',
      });
      setBusy('');
    }
  }

  const feedback = (section: string) => (
    <>
      {error.section === section && (
        <p className="error-message" role="alert">
          {error.message}
        </p>
      )}
      {success.section === section && (
        <p className="success-message" role="status">
          <Check size={15} />
          {success.message}
        </p>
      )}
    </>
  );
  const submit = (section: string, label: string) => (
    <button className="button button-primary" disabled={!!busy} type="submit">
      {busy === section && <LoaderCircle className="spin" size={16} />}
      {busy === section ? '保存中…' : label}
    </button>
  );

  if (loading)
    return (
      <div className="account-loading">
        <LoaderCircle className="spin" size={23} />
        <p>正在读取账户信息…</p>
      </div>
    );
  if (loadError)
    return (
      <div className="empty-state">
        <h2>暂时无法读取账户</h2>
        <p className="error-message" role="alert">
          {loadError}
        </p>
        <button className="button button-secondary" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  if (!user)
    return (
      <div className="empty-state">
        <UserRound size={30} />
        <h2>登录后管理你的账户</h2>
        <p>更新个人资料、管理密码，让每次对话都能继续。</p>
        <Link href="/login" className="button button-primary">
          前往登录
        </Link>
      </div>
    );
  return (
    <div className="account-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">YOUR PERSONAL SPACE</p>
          <h1>
            账户设置<span className="account-heading-star">✳</span>
          </h1>
          <p className="muted">整理个人资料，照顾好你的账户。</p>
        </div>
        <span className="account-page-number">/ 04</span>
      </header>
      <div className="settings-layout">
        <aside className="settings-summary">
          <div className="account-monogram">{user.username.slice(0, 1).toUpperCase()}</div>
          <h2>{user.username}</h2>
          <p>{user.email}</p>
          <span className="badge">{user.role === 'admin' ? '管理员' : '正式成员'}</span>
          <div className="settings-joined">
            <span>加入 ChatPony</span>
            <strong>
              {new Date(user.createdAt).toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </strong>
          </div>
          <Link href="/memories" className="settings-memory-link">
            <NotebookPen size={17} />
            <span>管理长期记忆</span>
            <ArrowUpRight size={16} />
          </Link>
        </aside>
        <div className="settings-sections">
          <QuotaCard />
          <section className="settings-section">
            <div className="settings-section-heading">
              <UserRound size={20} />
              <div>
                <h2>个人资料</h2>
                <p>这个名字会显示在对话中。</p>
              </div>
              <span>01</span>
            </div>
            <form className="account-form" onSubmit={(event) => save(event, 'profile')}>
              <label className="field" htmlFor="settings-username">
                <span>昵称</span>
                <input
                  id="settings-username"
                  name="username"
                  defaultValue={user.username}
                  required
                  minLength={2}
                  maxLength={32}
                  autoComplete="nickname"
                />
              </label>
              {feedback('profile')}
              <div className="settings-form-footer">
                <span>2—32 个字符</span>
                {submit('profile', '保存昵称')}
              </div>
            </form>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading">
              <Mail size={20} />
              <div>
                <h2>登录邮箱</h2>
                <p>用于登录和找回密码。</p>
              </div>
              <span>02</span>
            </div>
            <form className="account-form" onSubmit={(event) => save(event, 'email')}>
              <label className="field" htmlFor="settings-email">
                <span>邮箱地址</span>
                <input
                  id="settings-email"
                  name="email"
                  type="email"
                  defaultValue={user.email}
                  required
                  maxLength={254}
                  autoComplete="email"
                />
              </label>
              <PasswordInput
                id="email-password"
                name="currentPassword"
                label="当前密码"
                autoComplete="current-password"
                minLength={1}
              />
              {feedback('email')}
              <div className="settings-form-footer">
                <span>修改邮箱需要验证当前密码</span>
                {submit('email', '更新邮箱')}
              </div>
            </form>
          </section>
          <section className="settings-section">
            <div className="settings-section-heading">
              <KeyRound size={20} />
              <div>
                <h2>修改密码</h2>
                <p>使用一个仅用于 ChatPony 的密码。</p>
              </div>
              <span>03</span>
            </div>
            <form className="account-form" onSubmit={(event) => save(event, 'password')}>
              <PasswordInput
                id="current-password"
                name="currentPassword"
                label="当前密码"
                autoComplete="current-password"
                minLength={1}
              />
              <div className="form-grid">
                <PasswordInput
                  id="new-password"
                  name="newPassword"
                  label="新密码"
                  autoComplete="new-password"
                />
                <PasswordInput
                  id="confirm-new-password"
                  name="confirmPassword"
                  label="确认新密码"
                  autoComplete="new-password"
                />
              </div>
              {feedback('password')}
              <div className="settings-form-footer">
                <span>至少 10 位字符</span>
                {submit('password', '更新密码')}
              </div>
            </form>
          </section>
          <section className="settings-signout">
            <div>
              <ShieldCheck size={21} />
              <div>
                <h2>当前登录会话</h2>
                <p>离开共用设备前，记得退出登录。</p>
              </div>
            </div>
            <button
              type="button"
              className="button button-secondary"
              disabled={!!busy}
              onClick={logout}
            >
              <LogOut size={16} />
              {busy === 'logout' ? '正在退出…' : '退出登录'}
            </button>
            {feedback('logout')}
          </section>
          {user.role !== 'admin' && (
            <details className="settings-delete-section">
              <summary>注销账户</summary>
              <p>注销后，你的个人资料、对话与长期记忆将被永久删除。</p>
              <button
                className="button button-ghost"
                disabled={!!busy}
                onClick={() => {
                  setError({ section: '', message: '' });
                  setDeleteOpen(true);
                }}
              >
                <Trash2 size={15} />
                申请注销
              </button>
            </details>
          )}
        </div>
      </div>
      {deleteOpen && (
        <Dialog
          title="确认注销账户"
          eyebrow="CHATPONY / YOUR ACCOUNT"
          description="账户注销无法撤销，请确认你已保存需要保留的内容。"
          busy={busy === 'delete'}
          onClose={() => setDeleteOpen(false)}
        >
          <form className="account-form admin-editor-form" onSubmit={deleteAccount}>
            <p className="admin-info-note">这将永久删除你的账户、所有对话以及长期记忆。</p>
            <PasswordInput
              id="delete-password"
              name="password"
              label="输入当前密码以确认"
              autoComplete="current-password"
              minLength={1}
            />
            {feedback('delete')}
            <footer className="admin-dialog-footer">
              <div>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={!!busy}
                  data-dialog-close
                >
                  保留账户
                </button>
                <button className="button admin-danger-button" type="submit" disabled={!!busy}>
                  {busy === 'delete' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  {busy === 'delete' ? '注销中…' : '永久注销账户'}
                </button>
              </div>
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  );
}
