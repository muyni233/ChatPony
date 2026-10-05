'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, Check, LoaderCircle, Mail } from 'lucide-react';
import { api } from '@/lib/client';

export default function VerifyEmail() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  async function verify() {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setError('验证链接不完整，请从验证邮件中重新打开链接。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
      window.dispatchEvent(new Event('chatpony:session'));
      setDone(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '邮箱验证失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-form-wrap">
      <div className="auth-form-heading">
        <span className="auth-section-number">05 / VERIFY YOUR EMAIL</span>
        <h1>{done ? '邮箱已验证' : '确认你的邮箱'}</h1>
        <p>
          {done
            ? '账户已经准备好，下一段故事等待你开启。'
            : '点击下方按钮，完成邮箱验证并登录 ChatPony。'}
        </p>
      </div>
      <div className="auth-success">
        <span className="auth-success-icon">{done ? <Check size={24} /> : <Mail size={24} />}</span>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {done ? (
          <Link href="/" className="button button-primary">
            开始探索 <ArrowRight size={17} />
          </Link>
        ) : (
          <button className="button button-primary" disabled={busy} onClick={() => void verify()}>
            {busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}
            {busy ? '正在验证…' : '确认并验证邮箱'}
          </button>
        )}
      </div>
      {!done && (
        <div className="auth-switch">
          <Link href="/login">
            返回登录 <ArrowRight size={14} />
          </Link>
        </div>
      )}
    </div>
  );
}
