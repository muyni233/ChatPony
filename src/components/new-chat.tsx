'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, MessageCircle, Users, ArrowRight, UserRound, LockKeyhole } from 'lucide-react';
import { useApp } from './app-provider';
import { Avatar, Button, EmptyState, Field, Modal } from './ui';
import { api, json } from '@/lib/client';
import type { Conversation } from '@/lib/types';
import './user-characters.css';

export function NewChat({
  open,
  onClose,
  initialKind = 'private',
  initialCharacter,
}: {
  open: boolean;
  onClose: () => void;
  initialKind?: 'private' | 'group';
  initialCharacter?: string;
}) {
  const { data, refresh, notify } = useApp();
  const router = useRouter();
  const [kind, setKind] = useState(initialKind);
  const [selected, setSelected] = useState<string[]>(initialCharacter ? [initialCharacter] : []);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const characters = data?.characters || [];
  async function create() {
    setBusy(true);
    setError('');
    try {
      const conversation = await api<Conversation>(
        '/conversations',
        json('POST', {
          kind,
          characterIds: selected,
          ...(title.trim() ? { title: title.trim() } : {}),
        }),
      );
      await refresh();
      onClose();
      router.push(`/chat/${conversation.id}`);
      notify('新对话已创建。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="新建对话"
      description="选择私聊或群聊，然后选择角色。"
    >
      <div className="choice-tabs">
        <button
          aria-pressed={kind === 'private'}
          className={kind === 'private' ? 'selected' : ''}
          onClick={() => {
            setKind('private');
            setSelected(selected.slice(0, 1));
          }}
        >
          <MessageCircle size={18} />
          私聊
        </button>
        <button
          aria-pressed={kind === 'group'}
          className={kind === 'group' ? 'selected' : ''}
          onClick={() => setKind('group')}
        >
          <Users size={18} />
          群聊
        </button>
      </div>
      {!characters.length ? (
        <EmptyState
          icon={<UserRound size={24} />}
          title="暂无可用角色"
          description="你可以在「我的角色」中创建私有角色。"
          action={
            <Link href="/my-characters" className="button button-secondary" onClick={onClose}>
              前往我的角色
              <ArrowRight size={15} />
            </Link>
          }
        />
      ) : (
        <>
          <div className="character-picker">
            {characters.map((c) => (
              <button
                key={c.id}
                aria-pressed={selected.includes(c.id)}
                className={`character-option ${selected.includes(c.id) ? 'selected' : ''}`}
                onClick={() =>
                  setSelected(
                    kind === 'private'
                      ? [c.id]
                      : selected.includes(c.id)
                        ? selected.filter((i) => i !== c.id)
                        : [...selected, c.id],
                  )
                }
              >
                <Avatar name={c.name} src={c.avatar} color={c.color} />
                <span>
                  <strong>{c.name}</strong>
                  <small className="private-picker-handle">
                    {c.ownerId ? (
                      <span className="private-picker-origin">
                        <LockKeyhole size={10} />
                        我的角色 · 仅自己可见
                      </span>
                    ) : (
                      `@${c.slug}`
                    )}
                  </small>
                </span>
                <span className="check-box">{selected.includes(c.id) && <Check size={14} />}</span>
              </button>
            ))}
          </div>
          {kind === 'group' && (
            <p className="field-hint">至少选择 2 个角色。在群聊中 @角色名 可指定回复。</p>
          )}
          <Field label="对话名称（可选）">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={80}
              placeholder={kind === 'private' ? '例如：随便聊聊' : '例如：周末读书会'}
            />
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              onClick={create}
              loading={busy}
              disabled={selected.length < (kind === 'group' ? 2 : 1)}
            >
              开始对话
              <ArrowRight size={16} />
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
