'use client';
import { useCallback, useEffect, useId, useRef } from 'react';
import { X, Sparkles, ArrowUpRight, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { createPortal } from 'react-dom';
import type { Character } from '@/lib/types';

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path
          d="M31 11.5C24 5 12 6 8 14c-4 8 .5 17 10 18l-1.5 5 8-6c6-2 10-8 8-14"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="m22 7 1.8 5.2L29 14l-5.2 1.8L22 21l-1.8-5.2L15 14l5.2-1.8L22 7Z"
          fill="currentColor"
        />
        <path d="m32 1 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" fill="currentColor" />
      </svg>
    </span>
  );
}
export function CharacterAvatar({
  character,
  size = 'medium',
}: {
  character?: Pick<Character, 'name' | 'color' | 'avatar'>;
  size?: 'small' | 'medium' | 'large';
}) {
  return (
    <span
      aria-hidden="true"
      className={`character-avatar ${size}`}
      style={{ '--character-color': character?.color || '#718d79' } as React.CSSProperties}
    >
      {character?.avatar ? (
        <Image src={character.avatar} alt="" width={60} height={60} unoptimized />
      ) : (
        <span>{character?.name.slice(0, 1) || '✦'}</span>
      )}
    </span>
  );
}
export function Spinner({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle size={21} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function AuthPrompt({
  description = '登录后，你的对话与记忆会安全地保存在这里。',
}: {
  description?: string;
}) {
  return (
    <div className="empty-state auth-prompt">
      <div className="empty-symbol">
        <Sparkles size={30} strokeWidth={1.3} />
      </div>
      <h2>让故事有一个归处</h2>
      <p>{description}</p>
      <Link href="/login" className="button button-primary">
        登录 ChatPony <ArrowUpRight size={16} />
      </Link>
      <span className="small muted">
        还没有账号？{' '}
        <Link href="/register" className="text-link">
          立即注册
        </Link>
      </span>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  dismissible = true,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  dismissible?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const closingRef = useRef(false);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    dismissibleRef.current = dismissible;
  }, [dismissible]);
  const requestClose = useCallback(() => {
    if (closingRef.current || !dismissibleRef.current) return;
    const dialog = ref.current;
    if (!dialog || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      closeRef.current();
      return;
    }
    closingRef.current = true;
    const animation = dialog.animate(
      [
        { opacity: 1, transform: 'scale(1) translateY(0)' },
        { opacity: 0, transform: 'scale(.98) translateY(5px)' },
      ],
      { duration: 130, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'forwards' },
    );
    dialog.parentElement?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 130,
      fill: 'forwards',
    });
    void animation.finished.catch(() => {}).then(() => closeRef.current());
  }, []);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      ref.current?.animate(
        [
          { opacity: 0, transform: 'translateY(8px) scale(.98)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        { duration: 200, easing: 'cubic-bezier(.23,1,.32,1)' },
      );
    const elements = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex="0"]',
        ) || [],
      ).filter((el) => !el.hasAttribute('disabled'));
    elements()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[data-pony-select-menu]'))
      )
        return;
      if (event.key === 'Escape' && dismissibleRef.current) closeRef.current();
      if (event.key === 'Tab') {
        const items = elements();
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">CHATPONY</span>
            <h2 id={id}>{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={requestClose}
            disabled={!dismissible}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
