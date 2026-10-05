'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Globe2,
  KeyRound,
  LoaderCircle,
  Mail,
  MessagesSquare,
  Save,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { api } from '@/lib/client';
import { splitBubbles } from '@/lib/message-display';
import type { PromptMetadataOptions } from '@/lib/prompt-metadata';
import PromptMetadataSettings, { metadataDefaults } from './PromptMetadataSettings';

interface SiteConfig extends Partial<PromptMetadataOptions> {
  siteName: string;
  siteDescription: string;
  siteUrl: string;
  registrationEnabled: boolean;
  requireEmailVerification: boolean;
  allowedEmailDomains?: string[];
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpFrom: string;
  smtpHasPassword: boolean;
  localDemoMode: boolean;
  developmentMode?: boolean;
  trustProxy: boolean;
  quota5h?: number;
  quota1d?: number;
  quota7d?: number;
  quota5hEnabled?: boolean;
  quota1dEnabled?: boolean;
  quota7dEnabled?: boolean;
  maxMessagesPerConversation: number;
  maxConversationsPerUser: number;
  maxGroupReplies: number;
  maxGroupDepth: number;
  bubbleSeparator: string;
  hiddenOutputMarkers: string[];
  auditRetentionDays?: number;
}

function displaySeparator(value: string | undefined) {
  return (value ?? '|||').replace(/\n/g, '\\n');
}
function parseHiddenMarkers(value: string) {
  return [...new Set(value.split(/\r?\n/).filter((marker) => marker.length > 0))];
}
function parseEmailDomains(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
function markerValidation(markers: string[]) {
  if (markers.length > 16) return '最多设置 16 个不同的隐藏符号。';
  if (markers.some((marker) => marker.length > 80)) return '每个隐藏符号最多 80 个字符。';
  if (markers.some((marker) => /[\u0000-\u001f\u007f-\u009f]/.test(marker)))
    return '隐藏符号不能包含制表符等控制字符。';
  return '';
}

export default function SiteSettings() {
  const [settings, setSettings] = useState<SiteConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [siteUrlInput, setSiteUrlInput] = useState('');
  const [separatorInput, setSeparatorInput] = useState('|||');
  const [markerInput, setMarkerInput] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [metadata, setMetadata] = useState(metadataDefaults);

  useEffect(() => {
    let active = true;
    api<{ settings: SiteConfig }>('/api/admin/settings')
      .then((result) => {
        if (active) {
          setSettings(result.settings);
          setSiteUrlInput(result.settings.siteUrl);
          setSeparatorInput(displaySeparator(result.settings.bubbleSeparator));
          setMarkerInput((result.settings.hiddenOutputMarkers ?? []).join('\n'));
          setDomainInput((result.settings.allowedEmailDomains ?? []).join('\n'));
          setMetadata(metadataDefaults(result.settings));
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '站点设置加载失败。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const get = (name: string) => String(data.get(name) ?? '').trim();
    const hiddenOutputMarkers = parseHiddenMarkers(markerInput);
    const markerError = markerValidation(hiddenOutputMarkers);
    if (markerError) {
      setError(markerError);
      return;
    }
    const allowedEmailDomains = parseEmailDomains(domainInput);
    if (allowedEmailDomains.length > 64) {
      setError('最多设置 64 个邮箱域名。');
      return;
    }
    const payload = {
      siteName: get('siteName'),
      siteDescription: get('siteDescription'),
      siteUrl: get('siteUrl').replace(/\/$/, ''),
      registrationEnabled: data.get('registrationEnabled') === 'on',
      requireEmailVerification: data.get('requireEmailVerification') === 'on',
      smtpHost: get('smtpHost'),
      smtpPort: Number(data.get('smtpPort')),
      smtpSecure: data.get('smtpSecure') === 'on',
      smtpUser: get('smtpUser'),
      smtpFrom: get('smtpFrom'),
      ...(get('smtpPassword') ? { smtpPassword: get('smtpPassword') } : {}),
      localDemoMode: data.get('localDemoMode') === 'on',
      trustProxy: data.get('trustProxy') === 'on',
      quota5h: Number(data.get('quota5h')),
      quota7d: Number(data.get('quota7d')),
      maxMessagesPerConversation: Number(data.get('maxMessagesPerConversation')),
      maxConversationsPerUser: Number(data.get('maxConversationsPerUser')),
      maxGroupReplies: Number(data.get('maxGroupReplies')),
      maxGroupDepth: Number(data.get('maxGroupDepth')),
      bubbleSeparator: separatorInput,
      hiddenOutputMarkers,
    };
    setBusy('save');
    setError('');
    setSuccess('');
    try {
      const result = await api<{ settings: SiteConfig }>('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          ...payload,
          quota1d: Number(data.get('quota1d')),
          quota5hEnabled: data.get('quota5hEnabled') === 'on',
          quota1dEnabled: data.get('quota1dEnabled') === 'on',
          quota7dEnabled: data.get('quota7dEnabled') === 'on',
          allowedEmailDomains,
          auditRetentionDays: Number(data.get('auditRetentionDays')),
          ...metadata,
          promptTimezone: metadata.promptTimezone.trim(),
        }),
      });
      setSettings(result.settings);
      setSiteUrlInput(result.settings.siteUrl);
      setSeparatorInput(displaySeparator(result.settings.bubbleSeparator));
      setMarkerInput((result.settings.hiddenOutputMarkers ?? []).join('\n'));
      setDomainInput((result.settings.allowedEmailDomains ?? []).join('\n'));
      setMetadata(metadataDefaults(result.settings));
      setDirty(false);
      setRevision((previous) => previous + 1);
      setSuccess('站点设置已保存，新的设置立即生效。');
      window.dispatchEvent(new Event('chatpony:session'));
      window.dispatchEvent(new Event('chatpony:quota'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置保存失败，请重试。');
    } finally {
      setBusy('');
    }
  }

  async function sendTest() {
    setBusy('test');
    setError('');
    setSuccess('');
    try {
      const result = await api<{ ok: boolean; message: string }>('/api/admin/settings/test-email', {
        method: 'POST',
        body: '{}',
      });
      if (!result.ok) throw new Error(result.message || '测试邮件发送失败。');
      setSuccess(result.message || '测试邮件已发送至当前管理员的邮箱。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '测试邮件发送失败，请检查 SMTP 设置。');
    } finally {
      setBusy('');
    }
  }

  if (loading)
    return (
      <div className="account-loading">
        <LoaderCircle className="spin" size={22} />
        正在读取站点设置…
      </div>
    );
  if (!settings)
    return (
      <div className="admin-notice is-error" role="alert">
        <p>{error || '暂时无法加载站点设置。'}</p>
        <button className="button button-ghost" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );

  const previewMarkers = parseHiddenMarkers(markerInput);
  const previewSeparator = separatorInput.replace(/\\n/g, '\n');
  const sampleMarker = previewMarkers[0] ?? '';
  const previewSource = [
    `${sampleMarker}今天想聊些什么？${sampleMarker}`,
    `${sampleMarker}我会认真听你说。${sampleMarker}`,
  ].join(previewSeparator || ' ');
  const previewBubbles = splitBubbles(previewSource, previewSeparator, previewMarkers);

  return (
    <div className="admin-site-form">
      <div className="admin-section-heading">
        <div>
          <h2>站点设置</h2>
          <p>集中管理站点资料、注册方式与邮件服务。</p>
        </div>
      </div>
      {error && (
        <div className="admin-notice is-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {success && (
        <div className="admin-notice" role="status">
          <CheckCircle2 size={17} />
          <p>{success}</p>
        </div>
      )}
      <form
        key={revision}
        onSubmit={save}
        onChange={() => {
          setDirty(true);
          setSuccess('');
        }}
      >
        <section className="admin-site-section">
          <div className="admin-section-heading">
            <div>
              <span className="eyebrow">01 / THE BASICS</span>
              <h2>关于这个站点</h2>
            </div>
            <Globe2 size={20} color="#91a779" />
          </div>
          <div className="account-form">
            <label className="field" htmlFor="site-name">
              <span>
                站点名称 <b>*</b>
              </span>
              <input
                id="site-name"
                name="siteName"
                defaultValue={settings.siteName}
                required
                maxLength={60}
                placeholder="ChatPony"
              />
            </label>
            <label className="field" htmlFor="site-description">
              <span>站点描述</span>
              <textarea
                id="site-description"
                name="siteDescription"
                defaultValue={settings.siteDescription}
                rows={2}
                maxLength={300}
                placeholder="向用户介绍你的平台"
              />
            </label>
            <label className="field" htmlFor="site-url">
              <span>站点地址（邮件链接，可选）</span>
              <input
                id="site-url"
                name="siteUrl"
                type="url"
                value={siteUrlInput}
                onChange={(event) => setSiteUrlInput(event.target.value)}
                maxLength={500}
                placeholder="https://chat.example.com"
                aria-describedby="site-url-hint"
              />
              <small id="site-url-hint" className="field-hint">
                启用邮件时填写公开访问地址，包含协议和非默认端口，不含子路径。不使用邮件可留空；填错后仍可修改，不影响登录。
              </small>
              <span className="site-url-actions">
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={!!busy}
                  onClick={() => {
                    setSiteUrlInput(window.location.origin);
                    setDirty(true);
                    setSuccess('');
                  }}
                >
                  使用当前访问地址
                </button>
                <small className="field-hint">填入后点击「保存站点设置」生效。</small>
              </span>
            </label>
          </div>
        </section>
        <section className="admin-site-section">
          <div className="admin-section-heading">
            <div>
              <span className="eyebrow">02 / WELCOME NEW MEMBERS</span>
              <h2>注册与账户</h2>
            </div>
            <ShieldCheck size={20} color="#91a779" />
          </div>
          <label className="admin-checkbox">
            <input
              name="registrationEnabled"
              type="checkbox"
              defaultChecked={settings.registrationEnabled}
            />
            <span>
              <strong>开放公开注册</strong>
              <small>关闭后，新用户无法注册；已有账户可继续登录。</small>
            </span>
          </label>
          <label className="admin-checkbox">
            <input
              name="requireEmailVerification"
              type="checkbox"
              defaultChecked={settings.requireEmailVerification}
            />
            <span>
              <strong>注册时验证邮箱</strong>
              <small>新用户需要点击验证邮件激活账户。启用前请先保存并测试邮件服务。</small>
            </span>
          </label>
          <div className="account-form admin-registration-domains">
            <label className="field" htmlFor="site-email-domains">
              <span>允许注册的邮箱域名</span>
              <textarea
                id="site-email-domains"
                name="allowedEmailDomains"
                rows={3}
                value={domainInput}
                onChange={(event) => {
                  setDomainInput(event.target.value);
                  event.currentTarget.setCustomValidity(
                    parseEmailDomains(event.target.value).length > 64
                      ? '最多设置 64 个邮箱域名。'
                      : '',
                  );
                }}
                placeholder={'例如：qq.com\ngmail.com'}
                maxLength={16383}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="site-email-domains-hint"
              />
              <small id="site-email-domains-hint" className="field-hint">
                每行一个，最多 64 个；留空允许所有邮箱域名。填写域名本身，不含
                @，仅精确匹配，不自动包含子域名。已有账户登录不受影响。
              </small>
            </label>
          </div>
          <p>
            首个管理员账户不受邮箱域名限制，也无需邮箱验证。密码找回与邮箱变更仍需要可用的邮件服务。
          </p>
        </section>
        <section className="admin-site-section">
          <div className="admin-section-heading">
            <div>
              <span className="eyebrow">03 / MAIL DELIVERY</span>
              <h2>邮件服务</h2>
              <p>使用 SMTP 发送验证邮件与密码重置指引。</p>
            </div>
            <Mail size={20} color="#91a779" />
          </div>
          <div className="account-form">
            <div className="admin-site-smtp-grid">
              <label className="field" htmlFor="smtp-host">
                <span>SMTP 服务器</span>
                <input
                  id="smtp-host"
                  name="smtpHost"
                  defaultValue={settings.smtpHost}
                  maxLength={254}
                  placeholder="smtp.example.com"
                  autoComplete="off"
                />
              </label>
              <label className="field" htmlFor="smtp-port">
                <span>端口</span>
                <input
                  id="smtp-port"
                  name="smtpPort"
                  type="number"
                  defaultValue={settings.smtpPort}
                  required
                  min={1}
                  max={65535}
                  step={1}
                />
              </label>
            </div>
            <label className="admin-checkbox">
              <input name="smtpSecure" type="checkbox" defaultChecked={settings.smtpSecure} />
              <span>
                <strong>使用隐式 TLS（通常为 465 端口）</strong>
                <small>关闭时通过 STARTTLS 建立安全连接，通常使用 587 端口。</small>
              </span>
            </label>
            <div className="form-grid">
              <label className="field" htmlFor="smtp-user">
                <span>SMTP 用户名</span>
                <input
                  id="smtp-user"
                  name="smtpUser"
                  defaultValue={settings.smtpUser}
                  maxLength={254}
                  autoComplete="off"
                  placeholder="邮箱地址或服务商用户名"
                />
              </label>
              <label className="field" htmlFor="smtp-password">
                <span>SMTP 密码 / 授权码</span>
                <input
                  id="smtp-password"
                  name="smtpPassword"
                  type="password"
                  autoComplete="new-password"
                  maxLength={4096}
                  placeholder={
                    settings.smtpHasPassword ? '已保存，留空保持不变' : '输入 SMTP 密码或授权码'
                  }
                />
                <small className="field-hint">
                  <KeyRound size={12} />
                  密码在服务器加密保存。
                </small>
              </label>
            </div>
            <label className="field" htmlFor="smtp-from">
              <span>发件人</span>
              <input
                id="smtp-from"
                name="smtpFrom"
                defaultValue={settings.smtpFrom}
                maxLength={320}
                placeholder="ChatPony <hello@example.com>"
              />
              <small className="field-hint">
                可填写邮箱，或「名称 &lt;邮箱&gt;」。发件地址需获得邮件服务商授权。
              </small>
            </label>
            <div className="settings-form-footer">
              <span>
                {dirty ? '请先保存设置，再发送测试邮件' : '测试邮件将发至当前管理员的邮箱'}
              </span>
              <button
                className="button button-secondary"
                type="button"
                disabled={!!busy || dirty || !settings.smtpHost || !settings.smtpFrom}
                onClick={() => void sendTest()}
              >
                {busy === 'test' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
                {busy === 'test' ? '发送中…' : '发送测试邮件'}
              </button>
            </div>
          </div>
        </section>
        <section className="admin-site-section admin-display-section">
          <div className="admin-section-heading">
            <div>
              <span className="eyebrow">04 / THE WAY MESSAGES APPEAR</span>
              <h2>对话气泡与显示</h2>
              <p>调整角色回复的分段方式与显示内容。</p>
            </div>
            <MessagesSquare size={20} color="#91a779" />
          </div>
          <div className="account-form">
            <label className="field" htmlFor="site-bubble-separator">
              <span>分段符号</span>
              <input
                id="site-bubble-separator"
                name="bubbleSeparator"
                value={separatorInput}
                onChange={(event) => setSeparatorInput(event.target.value)}
                maxLength={40}
                placeholder="留空关闭分段"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="bubble-separator-hint"
              />
              <small className="field-hint" id="bubble-separator-hint">
                回复中的分段符号会转换为新气泡。可填写 <code>{'\\n\\n'}</code>{' '}
                按空行分段；留空关闭。
              </small>
            </label>
            <label className="field" htmlFor="site-hidden-markers">
              <span>隐藏符号</span>
              <textarea
                id="site-hidden-markers"
                name="hiddenOutputMarkers"
                rows={3}
                value={markerInput}
                onChange={(event) => {
                  setMarkerInput(event.target.value);
                  event.currentTarget.setCustomValidity(
                    markerValidation(parseHiddenMarkers(event.target.value)),
                  );
                }}
                maxLength={1295}
                placeholder="每行一个需要隐藏的符号"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="hidden-markers-hint"
              />
              <small className="field-hint" id="hidden-markers-hint">
                按原文精确匹配，不使用正则表达式。最多 16 个，每个 80 个字符；留空保留所有符号。
              </small>
            </label>
            <div className="admin-display-preview" aria-label="气泡显示实时预览">
              <header>
                <span>
                  <span />
                  实时预览
                </span>
                <small>{previewBubbles.length} 个气泡</small>
              </header>
              <div className="admin-display-preview-body">
                <div className="admin-preview-source">
                  <span>原始回复</span>
                  <pre>{previewSource}</pre>
                </div>
                <div className="admin-preview-result">
                  <span>显示效果</span>
                  <div className="admin-preview-bubbles">
                    {previewBubbles.length ? (
                      previewBubbles.map((part, index) => <p key={index}>{part}</p>)
                    ) : (
                      <small className="admin-preview-empty">这段示例内容已全部隐藏</small>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <p className="admin-save-note">
              以上规则仅作用于角色回复的显示。分段后再隐藏符号，历史消息原文仍会保留。
            </p>
          </div>
        </section>
        <PromptMetadataSettings
          value={metadata}
          disabled={!!busy}
          onChange={(next) => {
            setMetadata(next);
            setDirty(true);
            setSuccess('');
          }}
        />
        <section className="admin-site-section">
          <div className="admin-section-heading">
            <div>
              <span className="eyebrow">06 / ACCESS & USAGE</span>
              <h2>访问与用量</h2>
              <p>设置默认配额，也可以在用户管理中单独调整。</p>
            </div>
          </div>
          <div className="account-form">
            <div className="admin-quota-defaults">
              <div className="admin-quota-window-grid">
                {[
                  {
                    key: '5h',
                    tag: '5H',
                    duration: '5 小时',
                    name: 'quota5h',
                    enabledName: 'quota5hEnabled',
                    limit: settings.quota5h ?? 50,
                    enabled: settings.quota5hEnabled ?? true,
                  },
                  {
                    key: '1d',
                    tag: '1D',
                    duration: '1 天',
                    name: 'quota1d',
                    enabledName: 'quota1dEnabled',
                    limit: settings.quota1d ?? 100,
                    enabled: settings.quota1dEnabled ?? false,
                  },
                  {
                    key: '7d',
                    tag: '7D',
                    duration: '7 天',
                    name: 'quota7d',
                    enabledName: 'quota7dEnabled',
                    limit: settings.quota7d ?? 500,
                    enabled: settings.quota7dEnabled ?? true,
                  },
                ].map((window) => (
                  <div className="admin-quota-window-settings" key={window.key}>
                    <label className="admin-checkbox">
                      <input
                        id={`site-quota-${window.key}-enabled`}
                        name={window.enabledName}
                        type="checkbox"
                        defaultChecked={window.enabled}
                      />
                      <span>
                        <strong>启用 {window.tag} 配额</strong>
                        <small>连续 {window.duration}的使用上限</small>
                      </span>
                    </label>
                    <label className="field" htmlFor={`site-quota-${window.key}`}>
                      <span>每人可用次数</span>
                      <input
                        id={`site-quota-${window.key}`}
                        name={window.name}
                        type="number"
                        min={0}
                        max={1000000}
                        defaultValue={window.limit}
                        required
                        step={1}
                        inputMode="numeric"
                      />
                    </label>
                  </div>
                ))}
              </div>
              <p className="admin-quota-note">
                仅已启用的窗口参与限额判断；启用且设为 0 时暂停 AI 回复。每次用户发起 AI 回复计 1
                次，群聊同轮多个角色合计 1
                次；普通群消息不扣次数，失败或取消后返还。调整开关与上限不会清除已用次数。
              </p>
            </div>
            <div className="form-grid">
              <label className="field" htmlFor="site-max-messages">
                <span>每个会话最多消息数</span>
                <input
                  id="site-max-messages"
                  name="maxMessagesPerConversation"
                  type="number"
                  min={10}
                  max={10000}
                  defaultValue={settings.maxMessagesPerConversation ?? 2000}
                  required
                  step={1}
                />
              </label>
              <label className="field" htmlFor="site-max-conversations">
                <span>每人最多会话数</span>
                <input
                  id="site-max-conversations"
                  name="maxConversationsPerUser"
                  type="number"
                  min={1}
                  max={1000}
                  defaultValue={settings.maxConversationsPerUser ?? 200}
                  required
                  step={1}
                />
              </label>
            </div>
            <div className="form-grid">
              <label className="field" htmlFor="site-group-replies">
                <span>群聊每轮最多回复</span>
                <input
                  id="site-group-replies"
                  name="maxGroupReplies"
                  type="number"
                  min={1}
                  max={12}
                  defaultValue={settings.maxGroupReplies ?? 6}
                  required
                  step={1}
                />
                <small className="field-hint">包括你 @ 的角色及后续接力角色。</small>
              </label>
              <label className="field" htmlFor="site-group-depth">
                <span>群聊最多接力层数</span>
                <input
                  id="site-group-depth"
                  name="maxGroupDepth"
                  type="number"
                  min={1}
                  max={6}
                  defaultValue={settings.maxGroupDepth ?? 3}
                  required
                  step={1}
                />
                <small className="field-hint">
                  角色可 @ 其他成员继续对话；每个角色每轮最多回复一次。
                </small>
              </label>
            </div>
            <label className="admin-checkbox">
              <input
                name="trustProxy"
                type="checkbox"
                defaultChecked={settings.trustProxy ?? false}
              />
              <span>
                <strong>信任反向代理提供的客户端 IP</strong>
                <small>
                  只有部署在受信任的反向代理之后，并由代理覆盖 X-Forwarded-For
                  请求头时才启用。用于按来源限制请求频率。
                </small>
              </span>
            </label>
          </div>
        </section>
        <section className="admin-site-section">
          <div className="admin-section-heading">
            <div>
              <span className="eyebrow">07 / ADVANCED</span>
              <h2>高级设置</h2>
            </div>
          </div>
          <div className="account-form admin-audit-retention">
            <label className="field" htmlFor="site-audit-retention">
              <span>请求审计保留天数</span>
              <input
                id="site-audit-retention"
                name="auditRetentionDays"
                type="number"
                min={7}
                max={365}
                step={1}
                defaultValue={settings.auditRetentionDays ?? 90}
                required
                inputMode="numeric"
              />
              <small className="field-hint">
                保留 7—365
                天，过期记录自动清理。审计只保存请求元数据与脱敏错误，不记录对话正文或密钥。
              </small>
            </label>
          </div>
          <label className="admin-checkbox">
            <input
              name="localDemoMode"
              type="checkbox"
              defaultChecked={settings.localDemoMode}
              disabled={settings.developmentMode === false}
            />
            <span>
              <strong>
                本地演示模式{settings.developmentMode === false ? '（正式环境不可用）' : ''}
              </strong>
              <small>仅开发环境可用。使用演示回复检查对话交互；正式部署请连接真实模型。</small>
            </span>
          </label>
        </section>
        <footer className="admin-site-footer">
          <span>{dirty ? '有尚未保存的更改' : '所有设置均已保存'}</span>
          <button className="button button-primary" type="submit" disabled={!!busy || !dirty}>
            {busy === 'save' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {busy === 'save' ? '保存中…' : '保存站点设置'}
          </button>
        </footer>
      </form>
    </div>
  );
}
