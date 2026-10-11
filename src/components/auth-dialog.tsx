'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Mail,
  LockKeyhole,
  Eye,
  EyeOff,
  ShieldCheck,
  CheckCircle2,
} from 'lucide-react';
import { useApp } from './app-provider';
import { Button, Field, Modal } from './ui';
import { ApiError, api, json } from '@/lib/client';

export function AuthDialog() {
  const { authMode, closeAuth, openAuth, refresh, notify, data } = useApp();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [sending, setSending] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [clock, setClock] = useState(0);
  const [verificationNotice, setVerificationNotice] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const verificationRequired = authMode === 'register' && data?.settings.requireEmailVerification;
  const remaining = Math.max(0, Math.ceil((resendAt - clock) / 1000));
  const restrictedDomains = data?.settings.emailDomains || [];
  const domainHint =
    authMode === 'register' && data?.settings.emailDomainMode === 'allowlist'
      ? `可用邮箱域名：${restrictedDomains.join('、')}`
      : authMode === 'register' && data?.settings.emailDomainMode === 'blocklist'
        ? `以下邮箱域名暂不接受注册：${restrictedDomains.join('、')}`
        : undefined;
  useEffect(() => {
    setError('');
    setVisible(false);
    setEmail('');
    setVerificationCode('');
    setVerificationNotice('');
    setResendAt(0);
    formRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [authMode]);
  useEffect(() => {
    if (!resendAt) return;
    const update = () => {
      const time = Date.now();
      setClock(time);
      if (time >= resendAt) setResendAt(0);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  async function sendVerification() {
    const field = formRef.current?.elements.namedItem('email') as HTMLInputElement | null;
    if (!field?.reportValidity() || sending || remaining > 0) return;
    setSending(true);
    setError('');
    setVerificationNotice('');
    try {
      const result = await api<{ ok: true; retryAfter: number; expiresIn: number }>(
        '/auth/verification/send',
        json('POST', { email }),
      );
      const time = Date.now();
      setClock(time);
      setResendAt(time + result.retryAfter * 1000);
      setVerificationNotice(
        `验证码已发送至 ${email.trim()}，${Math.ceil(result.expiresIn / 60)} 分钟内有效。`,
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || sending) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(`/auth/${authMode}`, json('POST', Object.fromEntries(form)));
      await refresh();
      closeAuth();
      notify(authMode === 'register' ? '注册成功，欢迎来到 ChatPony。' : '欢迎回来。');
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && /VERIFICATION|DOMAIN|REGISTRATION/.test(e.code)) await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={!!authMode}
      onClose={() => !busy && !sending && closeAuth()}
      title={authMode === 'register' ? '你的故事，从这里开始' : '欢迎回到 ChatPony'}
      description={
        authMode === 'register'
          ? '创建账户，开启与小马利亚的每一次相遇。'
          : '登录后，继续上一次未完的对话。'
      }
    >
      <form ref={formRef} className="form-stack" onSubmit={submit} key={authMode}>
        {authMode === 'register' && (
          <Field label="昵称">
            <input
              name="name"
              autoComplete="nickname"
              placeholder="希望大家怎样称呼你？"
              minLength={1}
              maxLength={60}
              required
            />
          </Field>
        )}
        <Field label="邮箱" hint={domainHint}>
          <div className="input-icon">
            <Mail size={17} />
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              maxLength={254}
              value={email}
              disabled={busy || sending}
              onChange={(event) => {
                setEmail(event.target.value);
                setVerificationCode('');
                setVerificationNotice('');
                setResendAt(0);
              }}
              required
            />
          </div>
        </Field>
        {verificationRequired && (
          <Field label="邮箱验证码" hint="请输入收到的 6 位验证码；每个验证码只能使用一次。">
            <div className="verification-input-row">
              <div className="input-icon">
                <ShieldCheck size={17} />
                <input
                  name="verificationCode"
                  aria-label="邮箱验证码"
                  value={verificationCode}
                  onChange={(event) =>
                    setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6 位验证码"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                  disabled={busy}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={sendVerification}
                loading={sending}
                disabled={busy || !email.trim() || remaining > 0}
              >
                {remaining > 0 ? `${remaining} 秒后重发` : '发送验证码'}
              </Button>
            </div>
            {verificationNotice && (
              <span className="verification-notice" role="status">
                <CheckCircle2 size={14} />
                {verificationNotice}
              </span>
            )}
          </Field>
        )}
        <Field
          label="密码"
          hint={authMode === 'register' ? '至少 10 个字符，建议使用字母、数字和符号。' : undefined}
        >
          <div className="input-icon">
            <LockKeyhole size={17} />
            <input
              name="password"
              type={visible ? 'text' : 'password'}
              autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
              placeholder={authMode === 'register' ? '创建一个安全的密码' : '输入你的密码'}
              minLength={authMode === 'register' ? 10 : 1}
              maxLength={128}
              required
            />
            <button
              type="button"
              className="icon-button"
              aria-label={visible ? '隐藏密码' : '显示密码'}
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button
          type="submit"
          loading={busy}
          disabled={
            sending || (authMode === 'register' && data?.settings.registrationOpen === false)
          }
          className="button-full"
        >
          {authMode === 'register' ? '创建账户' : '登录'}
          <ArrowRight size={17} />
        </Button>
        <p className="auth-switch">
          {authMode === 'register' ? '已经有账户？' : '第一次来到这里？'}
          <button
            type="button"
            disabled={
              busy || sending || (authMode === 'login' && data?.settings.registrationOpen === false)
            }
            className="text-button"
            onClick={() => openAuth(authMode === 'login' ? 'register' : 'login')}
          >
            {authMode === 'register'
              ? '立即登录'
              : data?.settings.registrationOpen === false
                ? '注册暂未开放'
                : '注册账户'}
          </button>
        </p>
      </form>
    </Modal>
  );
}
