'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export default function Dialog({
  title,
  description,
  children,
  onClose,
  busy = false,
  wide = false,
  eyebrow = 'CHATPONY / MANAGEMENT',
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  eyebrow?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const headingId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const keyboard = document.activeElement?.matches(':focus-visible');
    dialog?.showModal();
    if (dialog && !keyboard && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog
        .animate(
          [
            { opacity: 0, transform: 'translateY(10px) scale(.985)' },
            { opacity: 1, transform: 'translateY(0) scale(1)' },
          ],
          { duration: 200, easing: 'cubic-bezier(.16,1,.3,1)' },
        )
        .finished.catch(() => {});
    }
    return () => {
      dialog?.getAnimations().forEach((animation) => animation.cancel());
      dialog?.close();
    };
  }, []);
  function requestClose(immediate = false) {
    if (busy || closing.current) return;
    const dialog = ref.current;
    if (!dialog || immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
      return;
    }
    closing.current = true;
    dialog.classList.add('is-closing');
    dialog
      .animate(
        [
          { opacity: 1, transform: 'translateY(0) scale(1)' },
          { opacity: 0, transform: 'translateY(7px) scale(.99)' },
        ],
        { duration: 140, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'forwards' },
      )
      .finished.then(() => {
        if (dialog.isConnected) onClose();
      })
      .catch(() => {});
  }
  return (
    <dialog
      ref={ref}
      className={`admin-dialog${wide ? ' admin-dialog-wide' : ''}`}
      aria-labelledby={headingId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        requestClose(true);
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button[data-dialog-close]')) {
          requestClose(event.detail === 0);
          return;
        }
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.target === event.currentTarget &&
          (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom)
        )
          requestClose();
      }}
    >
      <header className="admin-dialog-header">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2 id={headingId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <button
          className="admin-icon-button"
          type="button"
          aria-label="关闭弹窗"
          onClick={(event) => requestClose(event.detail === 0)}
          disabled={busy}
        >
          <X size={21} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
