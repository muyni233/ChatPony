'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import type { User } from '@/lib/types';

export type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

const content = {
  login: {
    index: '01',
    title: '欢迎回来',
    description: '登录后，继续属于你的故事。',
    submit: '登录 ChatPony',
  },
  register: {
    index: '02',
    title: '从这里，开启对话',
    description: '创建账户，和喜欢的角色慢慢熟悉。',
    submit: '创建账户',
  },
  forgot: {
    index: '03',
    title: '找回你的账户',
    description: '填写注册邮箱，我们会向你发送重置密码的指引。',
    submit: '发送重置邮件',
  },
  reset: {
    index: '04',
    title: '设置新的密码',
    description: '使用一个独立且足够长的密码保护你的账户。',
    submit: '重置密码',
  },
};

export function PasswordInput({
  id,
  name,
  label,
  autoComplete,
  minLength = 10,
  required = true,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  onChange?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <span className="password-field">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          maxLength={128}
          onChange={onChange}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={visible ? '隐藏密码' : '显示密码'}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}

export default function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [requireVerification, setRequireVerification] = useState(false);
  const [allowedEmailDomains, setAllowedEmailDomains] = useState<string[]>([]);
  const [ready, setReady] = useState(mode !== 'register' && mode !== 'login');
  const [pendingEmail, setPendingEmail] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);
  const copy = content[mode];

  useEffect(() => {
    if (mode !== 'register' && mode !== 'login') return;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    api<{
      bootstrapRequired: boolean;
      site?: {
        registrationEnabled: boolean;
        requireEmailVerification: boolean;
        allowedEmailDomains?: string[];
      };
    }>('/api/session', { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        setBootstrapRequired(result.bootstrapRequired);
        setRegistrationEnabled(result.site?.registrationEnabled ?? true);
        setRequireVerification(result.site?.requireEmailVerification ?? false);
        setAllowedEmailDomains(result.site?.allowedEmailDomains ?? []);
        setReady(true);
      })
      .catch((cause) => {
        if (active) {
          setError(
            controller.signal.aborted
              ? '读取账户设置超时，请重新加载页面。'
              : cause instanceof Error
                ? cause.message
                : '无法读取账户设置，请重新加载页面。',
          );
          setReady(false);
        }
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [mode]);

  async function resend() {
    if (!pendingEmail) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ message: string }>('/api/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email: pendingEmail }),
      });
      setSuccess(result.message || '如果此账户仍待验证，新的验证邮件会发送至你的邮箱。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '邮件发送失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSuccess('');
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    setPendingEmail(email);
    setNeedsVerification(false);
    if ((mode === 'register' || mode === 'reset') && password !== data.get('confirmPassword')) {
      setError('两次输入的密码不一致，请重新确认。');
      return;
    }
    if (mode === 'reset' && !token) {
      setError('重置链接不完整，请重新申请密码重置邮件。');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'forgot') {
        const result = await api<{ ok: boolean; message: string }>('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        setSuccess(
          result.message ||
            '如果这个邮箱已注册，重置指引会发送至你的邮箱，请留意收件箱和垃圾邮件。',
        );
      } else if (mode === 'reset') {
        await api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
        setSuccess('密码已更新。请使用新密码登录。');
      } else {
        const result = await api<{
          user: User | null;
          verificationRequired?: boolean;
          message?: string;
        }>(`/api/auth/${mode}`, {
          method: 'POST',
          body: JSON.stringify(
            mode === 'register'
              ? { email, password, username: String(data.get('username') ?? '').trim() }
              : { email, password },
          ),
        });
        if (result.verificationRequired) {
          setNeedsVerification(true);
          setSuccess(result.message || '注册已完成，请点击邮件中的链接验证邮箱后登录。');
          return;
        }
        window.dispatchEvent(new Event('chatpony:session'));
        router.push(
          mode === 'register' && result.user?.role === 'admin' ? '/admin?tab=settings' : '/',
        );
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法完成操作，请稍后重试。');
      if (cause instanceof ApiError && cause.code === 'EMAIL_NOT_VERIFIED')
        setNeedsVerification(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-form-wrap">
      <div className="auth-form-heading">
        <span className="auth-section-number">{copy.index} / YOUR ACCOUNT</span>
        <h1>{mode === 'register' && bootstrapRequired ? '欢迎创建 ChatPony' : copy.title}</h1>
        <p>
          {mode === 'register' && bootstrapRequired
            ? '创建首个账户，开始配置你的对话平台。'
            : copy.description}
        </p>
      </div>
      {bootstrapRequired && (
        <div className="auth-bootstrap">
          <strong>首次启动 · 创建管理员账号</strong>
          {mode === 'register' ? (
            '首个注册账户将自动成为管理员，无需邮件验证。注册后即可在后台配置模型、角色与邮件服务。'
          ) : (
            <>
              平台尚未初始化。<Link href="/register">创建首个管理员账户</Link>，开始配置 ChatPony。
            </>
          )}
        </div>
      )}
      {mode === 'register' && !registrationEnabled && !bootstrapRequired ? (
        <div className="auth-bootstrap">
          <strong>注册暂时关闭</strong>管理员暂时关闭了公开注册，已有账户仍可正常登录。
        </div>
      ) : success ? (
        <div className="auth-success" role="status">
          <span className="auth-success-icon">
            <Check size={25} />
          </span>
          <h2>{mode === 'reset' ? '新密码，已准备好' : '请查看你的邮箱'}</h2>
          <p>{success}</p>
          <Link href="/login" className="button button-primary">
            返回登录 <ArrowRight size={17} />
          </Link>
          {mode === 'forgot' && (
            <button type="button" className="button button-ghost" onClick={() => setSuccess('')}>
              重新填写邮箱
            </button>
          )}
          {needsVerification && (
            <button className="button button-ghost" disabled={busy} onClick={() => void resend()}>
              {busy ? '发送中…' : '重新发送验证邮件'}
            </button>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : (
        <form className="account-form auth-form" method="post" onSubmit={submit}>
          {mode === 'register' && (
            <label className="field" htmlFor="username">
              <span>你的昵称</span>
              <input
                id="username"
                name="username"
                autoComplete="nickname"
                placeholder="希望角色如何称呼你"
                required
                minLength={2}
                maxLength={32}
              />
            </label>
          )}
          {mode !== 'reset' && (
            <label className="field" htmlFor="email">
              <span>邮箱地址</span>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
                aria-describedby={
                  mode === 'register' && !bootstrapRequired && allowedEmailDomains.length
                    ? 'registration-email-domains'
                    : undefined
                }
              />
              {mode === 'register' && !bootstrapRequired && allowedEmailDomains.length > 0 && (
                <small className="auth-domain-hint" id="registration-email-domains">
                  <span>可使用的邮箱域名</span>
                  <span className="auth-domain-list">
                    {allowedEmailDomains.map((domain) => (
                      <span key={domain}>{domain}</span>
                    ))}
                  </span>
                  <span>仅接受上述域名，不包含其子域名。</span>
                </small>
              )}
            </label>
          )}
          {mode !== 'forgot' && (
            <PasswordInput
              id="password"
              name="password"
              label={mode === 'reset' ? '新密码' : '密码'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'login' ? 1 : 10}
            />
          )}
          {(mode === 'register' || mode === 'reset') && (
            <>
              <p className="field-hint password-hint">至少 10 位字符，建议混合字母、数字和符号。</p>
              <PasswordInput
                id="confirmPassword"
                name="confirmPassword"
                label="确认密码"
                autoComplete="new-password"
              />
            </>
          )}
          {mode === 'login' && (
            <div className="auth-form-extra">
              <span>只在信任的设备上登录</span>
              <Link href="/forgot-password">忘记密码？</Link>
            </div>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {!ready && error && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => window.location.reload()}
            >
              重新加载页面
            </button>
          )}
          {needsVerification && (
            <div className="auth-resend">
              <span>还没有收到验证邮件？</span>
              <button type="button" disabled={busy} onClick={() => void resend()}>
                重新发送
              </button>
            </div>
          )}
          <button
            className="button button-primary auth-submit"
            disabled={busy || !ready}
            type="submit"
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : null}
            {busy
              ? '请稍候…'
              : !ready
                ? error
                  ? '暂时无法读取账户设置'
                  : mode === 'register'
                    ? '正在读取注册设置…'
                    : '正在加载登录页面…'
                : mode === 'register' && bootstrapRequired
                  ? '创建管理员账户'
                  : copy.submit}
            {!busy && <ArrowRight size={18} />}
          </button>
          {mode === 'register' && (
            <p className="auth-privacy-note">
              {requireVerification && !bootstrapRequired
                ? '注册后需要验证邮箱，请使用可以接收邮件的地址。'
                : '你的对话与长期记忆归属于当前账户。请妥善保管登录信息。'}
            </p>
          )}
        </form>
      )}
      {!success && (
        <div className="auth-switch">
          {mode === 'login' ? (
            <>
              还没有账户？
              <Link href="/register">
                立即注册 <ArrowRight size={14} />
              </Link>
            </>
          ) : mode === 'register' ? (
            <>
              已经有账户？
              <Link href="/login">
                前往登录 <ArrowRight size={14} />
              </Link>
            </>
          ) : (
            <Link href="/login">
              返回登录 <ArrowRight size={14} />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
