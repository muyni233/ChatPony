'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, MessageCircle, Users, ArrowRight, Sparkles, LockKeyhole } from 'lucide-react';
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
      title="开启新的对话"
      description="选择对话方式，邀请角色加入你的故事。"
    >
      <div className="choice-tabs">
        <button
          className={kind === 'private' ? 'selected' : ''}
          onClick={() => {
            setKind('private');
            setSelected(selected.slice(0, 1));
          }}
        >
          <MessageCircle size={18} />
          单角色私聊
        </button>
        <button className={kind === 'group' ? 'selected' : ''} onClick={() => setKind('group')}>
          <Users size={18} />
          多角色群聊
        </button>
      </div>
      {!characters.length ? (
        <EmptyState
          icon={<Sparkles size={24} />}
          title="还没有可用的角色"
          description="可以创建自己的私有角色，或等待管理员在角色广场发布角色。"
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
            <p className="field-hint">
              至少选择 2 位角色。群聊中输入 @角色名称，即可邀请对方回应。
            </p>
          )}
          <Field label="对话名称（可选）">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={80}
              placeholder={kind === 'private' ? '例如：今天的小小分享' : '例如：周末的午后茶会'}
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
