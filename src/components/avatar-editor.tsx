'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Camera, ImagePlus, Link2, Trash2 } from 'lucide-react';
import { useApp } from './app-provider';
import { Avatar, Button, Field, Modal } from './ui';
import { api, json } from '@/lib/client';

export function AvatarEditorButton() {
  const { data, refresh, notify } = useApp();
  const user = data?.user;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setUrl(user?.avatar?.startsWith('http') ? user.avatar : '');
      setPreview('');
      setError('');
    }
  }, [open, user?.avatar]);
  if (!user) return null;
  async function saved() {
    await refresh();
    setOpen(false);
    notify('头像已更新。');
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('请选择 JPG、PNG 或 WebP 图片。');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('图片不能超过 2 MB。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('无法读取这张图片，请重新选择。'));
        reader.readAsDataURL(file);
      });
      setPreview(dataUrl);
      await api('/account/avatar', json('POST', { dataUrl }));
      await saved();
    } catch (reason) {
      setError((reason as Error).message);
      setPreview('');
    } finally {
      setBusy(false);
    }
  }
  async function saveUrl(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/account', json('PATCH', { avatar: url.trim() }));
      await saved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    setError('');
    try {
      await api('/account', json('PATCH', { avatar: '' }));
      await saved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="avatar-edit-trigger"
        onClick={() => setOpen(true)}
      >
        <Camera size={15} />
        更换头像
      </Button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="更换头像"
        description="头像会展示在账户、自设卡片和你的聊天消息中。"
      >
        <div className="avatar-edit-preview">
          <Avatar name={user.name} src={preview || user.avatar} size="large" />
          <span>{user.name}</span>
        </div>
        <input
          ref={fileInput}
          aria-label="上传头像文件"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="visually-hidden-input"
          tabIndex={-1}
          onChange={upload}
          disabled={busy}
        />
        <Button
          variant="secondary"
          type="button"
          className="button-full"
          loading={busy}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus size={17} />
          从设备选择图片
        </Button>
        <p className="field-hint">支持 JPG、PNG、WebP，最大 2 MB。上传后会裁为正方形头像。</p>
        <form className="form-stack avatar-url-form" onSubmit={saveUrl}>
          <Field label="或使用图片地址">
            <input
              type="url"
              pattern="https?://.*"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              maxLength={2048}
              placeholder="https://example.com/avatar.png"
              disabled={busy}
              required
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={busy || !url.trim()}>
            <Link2 size={15} />
            应用图片地址
          </Button>
        </form>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {user.avatar && (
          <Button
            type="button"
            variant="ghost"
            className="avatar-clear"
            disabled={busy}
            onClick={clear}
          >
            <Trash2 size={14} />
            恢复默认头像
          </Button>
        )}
      </Modal>
    </>
  );
}
