'use client';
import { Select } from '@/components/select';

import { useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle, Save } from 'lucide-react';
import type { Protocol, Provider } from '@/lib/types';
import { api } from '@/lib/client';
import Dialog from './Dialog';

export const protocolNames: Record<Protocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  gemini: 'Gemini Native',
};
const baseUrls: Record<Protocol, string> = {
  anthropic: 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export default function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: Provider | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [protocol, setProtocol] = useState<Protocol>(provider?.protocol ?? 'openai-chat');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? baseUrls['openai-chat']);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    const get = (name: string) => String(data.get(name) ?? '').trim();
    const contextWindow = Number(data.get('contextWindow'));
    const maxOutputTokens = Number(data.get('maxOutputTokens'));
    if (maxOutputTokens >= contextWindow / 2) {
      setError('最大输出长度须小于上下文窗口的一半，为对话保留足够空间。');
      return;
    }
    if (data.get('isDefault') === 'on' && data.get('enabled') !== 'on') {
      setError('默认模型接口必须保持启用。');
      return;
    }
    const payload = {
      name: get('name'),
      protocol,
      baseUrl: baseUrl.trim(),
      model: get('model'),
      contextWindow,
      maxOutputTokens,
      temperature: Number(data.get('temperature')),
      enabled: data.get('enabled') === 'on',
      isDefault: data.get('isDefault') === 'on',
      ...(get('apiKey') ? { apiKey: get('apiKey') } : {}),
    };
    setBusy(true);
    try {
      await api(provider ? `/api/admin/providers/${provider.id}` : '/api/admin/providers', {
        method: provider ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '接口保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  function chooseProtocol(value: Protocol) {
    if (!baseUrl || Object.values(baseUrls).includes(baseUrl)) setBaseUrl(baseUrls[value]);
    setProtocol(value);
  }

  return (
    <Dialog
      title={provider ? '编辑模型接口' : '添加模型接口'}
      description="配置模型协议与连接信息，为平台对话提供服务。"
      onClose={onClose}
      busy={busy}
      wide
    >
      <form className="account-form admin-editor-form" onSubmit={save}>
        <div className="admin-form-section-label">
          <span>01</span>连接信息
        </div>
        <div className="form-grid">
          <label className="field" htmlFor="provider-name">
            <span>
              接口名称 <b>*</b>
            </span>
            <input
              id="provider-name"
              name="name"
              defaultValue={provider?.name}
              required
              maxLength={80}
              placeholder="便于识别的名称"
            />
          </label>
          <label className="field" htmlFor="provider-protocol">
            <span>
              协议 <b>*</b>
            </span>
            <Select
              id="provider-protocol"
              value={protocol}
              onValueChange={(value) => chooseProtocol(value as Protocol)}
            >
              {Object.entries(protocolNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <label className="field" htmlFor="provider-url">
          <span>
            Base URL <b>*</b>
          </span>
          <input
            id="provider-url"
            name="baseUrl"
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            required
            maxLength={1000}
            placeholder={baseUrls[protocol]}
          />
          <small className="field-hint">填写 API 基础地址；系统会根据协议补全请求路径。</small>
        </label>
        <label className="field" htmlFor="provider-key">
          <span>API Key {!provider?.hasApiKey && <b>*</b>}</span>
          <input
            id="provider-key"
            name="apiKey"
            type="password"
            autoComplete="off"
            required={!provider?.hasApiKey}
            maxLength={4096}
            placeholder={
              provider?.hasApiKey ? '已保存密钥，留空即保持不变' : '输入服务商提供的 API Key'
            }
          />
          <small className="field-hint">
            <KeyRound size={13} /> 密钥在服务器加密保存，不会发送给普通用户。
          </small>
        </label>
        <label className="field" htmlFor="provider-model">
          <span>
            模型 ID <b>*</b>
          </span>
          <input
            id="provider-model"
            name="model"
            defaultValue={provider?.model}
            required
            maxLength={160}
            placeholder="填写服务商提供的完整模型名称"
          />
        </label>
        <div className="admin-form-section-label">
          <span>02</span>生成参数
        </div>
        <div className="admin-provider-numbers">
          <label className="field" htmlFor="provider-context">
            <span>上下文窗口</span>
            <input
              id="provider-context"
              name="contextWindow"
              type="number"
              min={2048}
              max={2000000}
              step={1}
              defaultValue={provider?.contextWindow ?? 32000}
              required
            />
          </label>
          <label className="field" htmlFor="provider-output">
            <span>最大输出 tokens</span>
            <input
              id="provider-output"
              name="maxOutputTokens"
              type="number"
              min={64}
              max={65536}
              step={1}
              defaultValue={provider?.maxOutputTokens ?? 2048}
              required
            />
          </label>
          <label className="field" htmlFor="provider-temp">
            <span>Temperature</span>
            <input
              id="provider-temp"
              name="temperature"
              type="number"
              min={0}
              max={2}
              step={0.05}
              defaultValue={provider?.temperature ?? 0.8}
              required
            />
          </label>
        </div>
        <p className="admin-info-note">
          上下文接近上限时，系统会压缩较早的对话，保留近期消息和长期记忆。请填写模型实际支持的窗口大小。
        </p>
        <div className="admin-checkbox-row">
          <label className="admin-checkbox">
            <input type="checkbox" name="enabled" defaultChecked={provider?.enabled ?? true} />
            <span>
              <strong>启用接口</strong>
              <small>允许对话使用此接口</small>
            </span>
          </label>
          <label className="admin-checkbox">
            <input type="checkbox" name="isDefault" defaultChecked={provider?.isDefault ?? false} />
            <span>
              <strong>设为默认</strong>
              <small>新建对话的默认模型</small>
            </span>
          </label>
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="admin-dialog-footer">
          <span>保存后可进行连接测试</span>
          <div>
            <button
              className="button button-secondary"
              type="button"
              data-dialog-close
              disabled={busy}
            >
              取消
            </button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              {busy ? '保存中…' : '保存接口'}
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}
