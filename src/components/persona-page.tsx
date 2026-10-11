'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Check, Fingerprint, Info, Sparkles, UserRound } from 'lucide-react';
import { useApp } from './app-provider';
import { Avatar, Badge, Button, Field } from './ui';
import { AuthRequired, Loading, PageHeading } from './library';
import { AvatarEditorButton } from './avatar-editor';
import { api, json } from '@/lib/client';
import type { UserPersona } from '@/lib/types';
import './persona.css';

const emptyPersona: UserPersona = {
  enabled: false,
  name: '',
  species: '',
  pronouns: '',
  appearance: '',
  personality: '',
  background: '',
};
export function PersonaPage() {
  const { data, loading, refresh, notify } = useApp();
  const user = data?.user;
  const saved = JSON.stringify(user?.persona || emptyPersona);
  const [draft, setDraft] = useState<UserPersona>(emptyPersona);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(JSON.parse(saved));
  }, [saved]);
  const dirty = JSON.stringify(draft) !== saved;
  const length = Object.values(draft).reduce<number>(
    (sum, value) => sum + (typeof value === 'string' ? value.length : 0),
    0,
  );
  function field(key: keyof UserPersona, value: string | boolean) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (length > 6000) {
      setError('自设卡片的总内容不能超过 6,000 字。');
      return;
    }
    setBusy(true);
    try {
      await api('/account/persona', json('PATCH', draft));
      await refresh();
      notify(draft.enabled ? '自设卡片已保存，将用于后续对话。' : '自设卡片已保存，当前未启用。');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="YOUR CHARACTER, YOUR STORY"
        title="我的自设"
        description="填写属于你的 RP 身份，让角色在对话中更了解你的设定。"
      />
      {loading ? (
        <Loading />
      ) : !user ? (
        <AuthRequired
          title="创建属于你的自设卡片"
          description="登录后可以管理自己的角色扮演身份与头像。"
        />
      ) : (
        <div className="persona-layout">
          <form className="paper-card persona-editor" onSubmit={submit}>
            <div className="persona-section-title">
              <Fingerprint size={19} />
              <h2>自设资料</h2>
              <Badge tone={draft.enabled ? 'green' : 'neutral'}>
                {draft.enabled ? '已启用' : '未启用'}
              </Badge>
            </div>
            <div className="page-intro-note">
              <Info size={16} />
              <span>
                这是你在对话中的身份卡片，不会新增平台角色。自设名称仅用于角色扮演，不修改账户昵称。
              </span>
            </div>
            <fieldset disabled={busy}>
              <label className="toggle-row persona-enabled">
                <span>
                  在对话中使用自设
                  <small>启用后，新消息会带上这张卡片；关闭时会保留已填写资料。</small>
                </span>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => field('enabled', event.target.checked)}
                />
              </label>
              <Field label="自设名称">
                <input
                  value={draft.name}
                  onChange={(event) => field('name', event.target.value)}
                  maxLength={60}
                  placeholder="在故事中，希望被如何称呼？"
                />
              </Field>
              <div className="form-grid">
                <Field label="种族 / 身份">
                  <input
                    value={draft.species}
                    onChange={(event) => field('species', event.target.value)}
                    maxLength={60}
                    placeholder="例如：独角兽、飞马"
                  />
                </Field>
                <Field label="称谓">
                  <input
                    value={draft.pronouns}
                    onChange={(event) => field('pronouns', event.target.value)}
                    maxLength={40}
                    placeholder="可选，例如：她 / 他 / TA"
                  />
                </Field>
              </div>
              <Field label="外貌特征" hint="可以描述毛色、鬃毛、瞳色、可爱标记、穿着等特征。">
                <textarea
                  value={draft.appearance}
                  onChange={(event) => field('appearance', event.target.value)}
                  maxLength={1500}
                  rows={3}
                  placeholder="描述你的形象…"
                />
              </Field>
              <Field label="性格与偏好">
                <textarea
                  value={draft.personality}
                  onChange={(event) => field('personality', event.target.value)}
                  maxLength={1500}
                  rows={3}
                  placeholder="性格、兴趣、习惯，以及希望的互动方式…"
                />
              </Field>
              <Field label="背景设定">
                <textarea
                  value={draft.background}
                  onChange={(event) => field('background', event.target.value)}
                  maxLength={3000}
                  rows={5}
                  placeholder="你的经历、生活地点、关系和故事背景…"
                />
              </Field>
            </fieldset>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="persona-save">
              <span>
                {length.toLocaleString()} / 6,000 字{dirty && ' · 尚未保存'}
              </span>
              <Button type="submit" loading={busy} disabled={!dirty || length > 6000}>
                <Check size={16} />
                保存自设
              </Button>
            </div>
          </form>
          <aside className="persona-preview-column">
            <section className="persona-card">
              <span className="tape tape-mint" />
              <div className="persona-card-label">
                <span>PERSONA CARD</span>
                <Sparkles size={17} />
              </div>
              <Avatar name={draft.name || user.name} src={user.avatar} size="large" />
              <h2>{draft.name || user.name}</h2>
              <div className="persona-tags">
                {draft.species && <Badge tone="green">{draft.species}</Badge>}
                {draft.pronouns && <Badge tone="pink">{draft.pronouns}</Badge>}
              </div>
              <div className="persona-card-rule" />
              <div className="persona-card-details">
                {[
                  ['外貌', draft.appearance],
                  ['性格', draft.personality],
                  ['背景', draft.background],
                ].map(([label, content]) => (
                  <div key={label}>
                    <h3>{label}</h3>
                    <p>{content || '等待你来填写'}</p>
                  </div>
                ))}
              </div>
              <div className="persona-card-footer">
                <UserRound size={12} />
                {draft.enabled ? '用于私聊与群聊' : '保存并启用后用于对话'}
              </div>
            </section>
            <div className="persona-avatar-action">
              <AvatarEditorButton />
              <p>使用你上传的头像，或填写图片地址。</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
