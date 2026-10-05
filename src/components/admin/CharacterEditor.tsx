'use client';

import { useState, type FormEvent } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import type { Character } from '@/lib/types';
import { api } from '@/lib/client';
import Dialog from './Dialog';

export default function CharacterEditor({
  character,
  onClose,
  onSaved,
}: {
  character: Character | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [color, setColor] = useState(character?.color ?? '#7d9278');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const get = (name: string) => String(data.get(name) ?? '').trim();
    const tags = [
      ...new Set(
        get('tags')
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (tags.length > 8 || tags.some((tag) => tag.length > 24)) {
      setError('每个角色最多添加 8 个标签，每个标签不超过 24 个字符。');
      return;
    }
    const payload = {
      name: get('name'),
      englishName: get('englishName'),
      subtitle: get('subtitle'),
      description: get('description'),
      personality: get('personality'),
      greeting: get('greeting'),
      color,
      avatar: get('avatar'),
      tags,
      published: data.get('published') === 'on',
      order: Number(data.get('order') ?? 0),
    };
    setBusy(true);
    try {
      await api(character ? `/api/admin/characters/${character.id}` : '/api/admin/characters', {
        method: character ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={character ? '编辑角色' : '创建角色'}
      description="资料用于角色展示；人设决定角色在对话中的表达方式。"
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="account-form admin-editor-form" onSubmit={save}>
        <div className="admin-form-section-label">
          <span>01</span>角色资料
        </div>
        <div className="form-grid">
          <label className="field" htmlFor="character-name">
            <span>
              角色名称 <b>*</b>
            </span>
            <input
              id="character-name"
              name="name"
              defaultValue={character?.name}
              required
              maxLength={60}
              placeholder="输入角色名称"
            />
          </label>
          <label className="field" htmlFor="character-english">
            <span>英文名称</span>
            <input
              id="character-english"
              name="englishName"
              defaultValue={character?.englishName}
              maxLength={80}
              placeholder="可选"
            />
          </label>
        </div>
        <label className="field" htmlFor="character-subtitle">
          <span>一句话介绍</span>
          <input
            id="character-subtitle"
            name="subtitle"
            defaultValue={character?.subtitle}
            maxLength={120}
            placeholder="简短地介绍这个角色"
          />
        </label>
        <label className="field" htmlFor="character-description">
          <span>
            角色介绍 <b>*</b>
          </span>
          <textarea
            id="character-description"
            name="description"
            defaultValue={character?.description}
            required
            rows={3}
            maxLength={3000}
            placeholder="向用户介绍角色的背景、身份和特点"
          />
        </label>
        <div className="form-grid">
          <label className="field" htmlFor="character-tags">
            <span>角色标签</span>
            <input
              id="character-tags"
              name="tags"
              defaultValue={character?.tags.join('，')}
              maxLength={200}
              placeholder="用逗号分隔，最多 8 个"
            />
          </label>
          <div className="field">
            <label htmlFor="character-color">标识颜色</label>
            <div className="admin-color-field">
              <input
                type="color"
                id="character-color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
              />
              <span>{color.toUpperCase()}</span>
              <small>用于角色标识与细节</small>
            </div>
          </div>
        </div>
        <div className="admin-form-section-label">
          <span>02</span>对话设定
        </div>
        <label className="field" htmlFor="character-personality">
          <span>
            角色人设 <b>*</b>
          </span>
          <textarea
            id="character-personality"
            name="personality"
            defaultValue={character?.personality}
            required
            rows={7}
            maxLength={16000}
            placeholder="描述性格、语气、关系背景、知识范围和角色扮演边界。内容仅用于模型提示，不会在角色目录公开。"
          />
          <small className="field-hint">建议使用清晰、具体的表达，明确角色与用户的互动方式。</small>
        </label>
        <label className="field" htmlFor="character-greeting">
          <span>开场白</span>
          <textarea
            id="character-greeting"
            name="greeting"
            defaultValue={character?.greeting}
            rows={3}
            maxLength={3000}
            placeholder="用户首次开始私聊时，角色说的第一句话"
          />
        </label>
        <details className="admin-advanced">
          <summary>显示与排序设置</summary>
          <div className="form-grid">
            <label className="field" htmlFor="character-order">
              <span>排序权重</span>
              <input
                id="character-order"
                name="order"
                type="number"
                min={-9999}
                max={9999}
                defaultValue={character?.order ?? 0}
                step={1}
              />
              <small className="field-hint">数值越小，越靠前显示。</small>
            </label>
            <label className="field" htmlFor="character-avatar">
              <span>头像资源路径（可选）</span>
              <input
                id="character-avatar"
                name="avatar"
                defaultValue={character?.avatar}
                placeholder="/uploads/avatar.webp"
                maxLength={500}
                pattern="/[^/].*"
              />
              <small className="field-hint">留空时显示文字标识；支持站内资源路径。</small>
            </label>
          </div>
        </details>
        <label className="admin-checkbox">
          <input type="checkbox" name="published" defaultChecked={character?.published ?? false} />
          <span>
            <strong>发布角色</strong>
            <small>发布后，所有登录用户都可以与此角色对话。</small>
          </span>
        </label>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="admin-dialog-footer">
          <span>{character ? '修改会应用于之后的对话' : '未勾选发布时，将保存为草稿'}</span>
          <div>
            <button
              type="button"
              className="button button-secondary"
              data-dialog-close
              disabled={busy}
            >
              取消
            </button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              {busy ? '保存中…' : '保存角色'}
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}
