'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Globe2,
  LockKeyhole,
  Mail,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { MailDeliveryLog } from '@/components/mail-delivery-log';
import { Badge, Button, Field, Select } from '@/components/ui';
import { api, json } from '@/lib/client';
import type { MailConfig, PlatformSettings } from '@/lib/types';

function smtpDraft(config: MailConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    username: config.username,
    password: '',
    fromEmail: config.fromEmail,
    fromName: config.fromName,
  };
}
const emptyMail: MailConfig = {
  host: '',
  port: 587,
  secure: false,
  requireTLS: true,
  username: '',
  hasPassword: false,
  fromEmail: '',
  fromName: '',
};
function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请稍后重试。';
}
function MailError({ error }: { error: string }) {
  return error ? (
    <div className="admin-error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
function MailToggle({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="admin-toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        className="admin-toggle"
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="admin-toggle-track" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

export function MailSettings({
  settings,
  onChanged,
  onOpenSettings,
}: {
  settings: PlatformSettings;
  onChanged: () => Promise<void>;
  onOpenSettings: () => void;
}) {
  const { notify } = useApp();
  const [config, setConfig] = useState<MailConfig | null>(null);
  const [draft, setDraft] = useState(() => smtpDraft(emptyMail));
  const [clearPassword, setClearPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'save' | 'test' | 'send' | null>(null);
  const [testResult, setTestResult] = useState('');
  const [testEmail, setTestEmail] = useState('');
  const [sendError, setSendError] = useState('');
  const [sendResult, setSendResult] = useState('');
  const [deliveryRefresh, setDeliveryRefresh] = useState(0);
  const [requireVerification, setRequireVerification] = useState(settings.requireEmailVerification);
  const [domainMode, setDomainMode] = useState<PlatformSettings['emailDomainMode']>(
    settings.emailDomainMode,
  );
  const savedDomainsText = settings.emailDomains.join('\n');
  const [domainsText, setDomainsText] = useState(savedDomainsText);
  const [policyPending, setPolicyPending] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const domains = [
    ...new Set(
      domainsText
        .split(/\r?\n/)
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const dirty = config
    ? JSON.stringify(draft) !== JSON.stringify(smtpDraft(config)) || clearPassword
    : false;
  const complete = !!config?.host.trim() && !!config?.fromEmail.trim();
  const policyDirty =
    requireVerification !== settings.requireEmailVerification ||
    domainMode !== settings.emailDomainMode ||
    JSON.stringify(domains) !== JSON.stringify(settings.emailDomains);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    api<MailConfig>('/api/admin/mail', { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setConfig(value);
        setDraft(smtpDraft(value));
        setClearPassword(false);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setLoadError(errorText(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    setRequireVerification(settings.requireEmailVerification);
    setDomainMode(settings.emailDomainMode);
    setDomainsText(savedDomainsText);
  }, [settings.requireEmailVerification, settings.emailDomainMode, savedDomainsText]);

  async function saveMail(event: FormEvent) {
    event.preventDefault();
    if (pending || !config) return;
    setError('');
    setPending('save');
    try {
      const value = await api<MailConfig>(
        '/api/admin/mail',
        json('PATCH', {
          ...draft,
          host: draft.host.trim(),
          username: draft.username.trim(),
          fromEmail: draft.fromEmail.trim(),
          fromName: draft.fromName.trim(),
          password: clearPassword ? '' : draft.password || undefined,
        }),
      );
      setConfig(value);
      setDraft(smtpDraft(value));
      setClearPassword(false);
      setTestResult('');
      setSendResult('');
      setSendError('');
      await onChanged();
      notify('SMTP 配置已保存', 'success');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(null);
    }
  }

  async function testConnection() {
    if (pending || dirty || !complete) return;
    setError('');
    setTestResult('');
    setPending('test');
    try {
      const value = await api<{ ok: boolean; message?: string }>(
        '/api/admin/mail/test',
        json('POST', {}),
      );
      if (!value.ok) {
        setError(value.message || 'SMTP 连接测试失败。');
        return;
      }
      setTestResult(
        'SMTP 连接与鉴权验证成功。此检查不会发送邮件，也不代表服务器允许发信或邮件已送达。',
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(null);
      setDeliveryRefresh((value) => value + 1);
    }
  }

  async function sendTestEmail(event: FormEvent) {
    event.preventDefault();
    if (pending || dirty || !complete || !testEmail.trim()) return;
    setSendError('');
    setSendResult('');
    setPending('send');
    try {
      const value = await api<{ ok: boolean; message: string; id: string }>(
        '/api/admin/mail/send-test',
        json('POST', { email: testEmail.trim() }),
      );
      if (!value.ok) {
        setSendError(value.message || '测试邮件发送失败，请查看下方邮件发送记录。');
        return;
      }
      setSendResult(
        `SMTP 服务器已接受，请检查收件箱或垃圾邮件。尚不能保证最终送达。参考编号：${value.id}`,
      );
    } catch (reason) {
      setSendError(errorText(reason));
    } finally {
      setPending(null);
      setDeliveryRefresh((value) => value + 1);
    }
  }

  async function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (policyPending) return;
    setPolicyError('');
    if (requireVerification && !complete) {
      setPolicyError('请先保存完整的 SMTP 主机与发件邮箱，再启用注册邮箱验证。');
      return;
    }
    if (domainMode === 'allowlist' && !domains.length) {
      setPolicyError('仅允许指定域名时，请至少填写一个邮箱域名。');
      return;
    }
    if (
      domains.length > 100 ||
      domains.some((domain) => domain.replace(/^\*\./, '').length > 253)
    ) {
      setPolicyError('最多设置 100 个域名，每个域名不超过 253 个字符（不含 *. 前缀）。');
      return;
    }
    setPolicyPending(true);
    try {
      await api<PlatformSettings>(
        '/api/admin/settings',
        json('PATCH', {
          requireEmailVerification: requireVerification,
          emailDomainMode: domainMode,
          emailDomains: domains,
        }),
      );
      await onChanged();
      notify('注册邮箱策略已保存', 'success');
    } catch (reason) {
      setPolicyError(errorText(reason));
    } finally {
      setPolicyPending(false);
    }
  }

  return (
    <div className="admin-mail-page">
      <div className="admin-section-title">
        <div>
          <h2>邮件与注册验证</h2>
          <p>配置邮件服务，并选择是否验证注册邮箱、限制可注册的邮箱域名。</p>
        </div>
        <Badge tone={settings.requireEmailVerification ? 'green' : 'neutral'}>
          {settings.requireEmailVerification ? '注册需验证邮箱' : '注册无需邮箱验证'}
        </Badge>
      </div>
      <div className="admin-mail-grid">
        <section className="admin-mail-card">
          <div className="admin-mail-card-heading">
            <span className="admin-mail-icon">
              <Mail size={22} strokeWidth={1.5} />
            </span>
            <div>
              <h3>SMTP 邮件服务</h3>
              <p>用于发送注册验证码</p>
            </div>
            {config && (
              <Badge tone={complete ? 'green' : 'neutral'}>
                {complete ? '已配置' : '尚未配置'}
              </Badge>
            )}
          </div>
          {loading && !config && (
            <div className="admin-loading" role="status">
              <RefreshCw size={22} className="spin" />
              <p>正在读取邮件配置…</p>
            </div>
          )}
          {loadError && (
            <div className="admin-mail-load-error">
              <MailError error={loadError} />
              <Button
                type="button"
                variant="secondary"
                loading={loading}
                onClick={() => setReload((value) => value + 1)}
              >
                重新加载
              </Button>
            </div>
          )}
          {config && (
            <form
              className="admin-form admin-mail-form"
              onSubmit={saveMail}
              aria-busy={pending === 'save'}
            >
              <fieldset className="admin-mail-fields" disabled={pending !== null}>
                <div className="admin-form-grid admin-mail-host-grid">
                  <Field label="SMTP 主机" hint="填写主机名，不包含 http:// 或端口。">
                    <input
                      maxLength={253}
                      autoComplete="off"
                      placeholder="smtp.example.com"
                      value={draft.host}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, host: event.target.value }))
                      }
                    />
                  </Field>
                  <Field label="SMTP 端口">
                    <input
                      required
                      type="number"
                      min={1}
                      max={65535}
                      step={1}
                      value={draft.port}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, port: Number(event.target.value) }))
                      }
                    />
                  </Field>
                </div>
                <MailToggle
                  label="使用隐式 TLS"
                  description="通常使用 465 端口；关闭时可通过 STARTTLS 升级连接。"
                  value={draft.secure}
                  onChange={(value) =>
                    setDraft((previous) => ({
                      ...previous,
                      secure: value,
                      port:
                        value && previous.port === 587
                          ? 465
                          : !value && previous.port === 465
                            ? 587
                            : previous.port,
                    }))
                  }
                />
                {!draft.secure && (
                  <MailToggle
                    label="要求 STARTTLS"
                    description="要求服务器支持加密升级。关闭后可连接未提供 TLS 的服务。"
                    value={draft.requireTLS}
                    onChange={(value) =>
                      setDraft((previous) => ({ ...previous, requireTLS: value }))
                    }
                  />
                )}
                <Field label="SMTP 用户名" hint="无需身份验证的本地邮件服务可以留空。">
                  <input
                    maxLength={320}
                    autoComplete="off"
                    placeholder="user@example.com"
                    value={draft.username}
                    onChange={(event) =>
                      setDraft((previous) => ({ ...previous, username: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label="SMTP 密码或授权码"
                  hint={
                    config.hasPassword
                      ? '已加密保存；留空保留现有密码，填写新值可替换。'
                      : '根据邮件服务商要求填写密码或应用授权码。'
                  }
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={8192}
                    disabled={clearPassword}
                    placeholder={
                      config.hasPassword ? '••••••••（已加密保存）' : '输入 SMTP 密码或授权码'
                    }
                    value={draft.password}
                    onChange={(event) =>
                      setDraft((previous) => ({ ...previous, password: event.target.value }))
                    }
                  />
                </Field>
                {config.hasPassword && (
                  <MailToggle
                    label="清除已保存的 SMTP 密码"
                    description="仅适用于无需身份验证的邮件服务，保存后生效。"
                    value={clearPassword}
                    onChange={setClearPassword}
                  />
                )}
                <div className="admin-form-grid">
                  <Field label="发件邮箱" hint="使用邮件服务允许的发件地址。">
                    <input
                      type="email"
                      maxLength={254}
                      placeholder="noreply@example.com"
                      value={draft.fromEmail}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, fromEmail: event.target.value }))
                      }
                    />
                  </Field>
                  <Field label="发件人名称">
                    <input
                      maxLength={100}
                      placeholder="ChatPony"
                      value={draft.fromName}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, fromName: event.target.value }))
                      }
                    />
                  </Field>
                </div>
                <MailError error={error} />
                {testResult && !dirty && (
                  <div className="admin-embedding-success" role="status">
                    <CheckCircle2 size={17} />
                    <span>{testResult}</span>
                  </div>
                )}
                <div className="admin-mail-actions">
                  <span>
                    {dirty
                      ? '请先保存更改，再测试已保存的配置。'
                      : '连接测试仅检查连接与鉴权，不会发送邮件。'}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={pending === 'test'}
                    disabled={dirty || !complete || (pending !== null && pending !== 'test')}
                    onClick={() => void testConnection()}
                  >
                    <Activity size={15} />
                    测试 SMTP 连接
                  </Button>
                  <Button
                    type="submit"
                    loading={pending === 'save'}
                    disabled={!dirty || (pending !== null && pending !== 'save')}
                  >
                    <Check size={16} />
                    保存邮件配置
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
        </section>
        <aside className="admin-mail-note">
          <span className="admin-paperclip" aria-hidden="true" />
          <h3>按需开启邮箱验证</h3>
          <p>邮箱验证默认关闭，配置好邮件服务后即可按需启用。</p>
          <div>
            <Mail size={17} />
            <span>
              <strong>先保存邮件配置</strong>
              <small>填写主机、端口和发件邮箱，按需设置身份验证。</small>
            </span>
          </div>
          <div>
            <ShieldCheck size={17} />
            <span>
              <strong>检查连接与鉴权</strong>
              <small>连接成功后，再发送一封测试邮件，检查发件权限和收件情况。</small>
            </span>
          </div>
          <div>
            <Globe2 size={17} />
            <span>
              <strong>设置可注册的域名</strong>
              <small>支持允许名单、禁止名单，以及明确的子域通配规则。</small>
            </span>
          </div>
          <div className="admin-mail-registration-state">
            <Badge tone={settings.registrationOpen ? 'green' : 'amber'}>
              {settings.registrationOpen ? '平台注册已开放' : '平台注册已关闭'}
            </Badge>
            <button type="button" className="admin-text-link" onClick={onOpenSettings}>
              平台设置 <ArrowUpRight size={14} />
            </button>
          </div>
        </aside>
      </div>
      <section className="admin-mail-card admin-mail-send-card">
        <div className="admin-mail-card-heading">
          <span className="admin-mail-icon">
            <Send size={21} strokeWidth={1.5} />
          </span>
          <div>
            <h3>发送测试邮件</h3>
            <p>实际检查发件流程，使用已保存的 SMTP 配置。</p>
          </div>
        </div>
        <form
          className="admin-form admin-mail-send-form"
          onSubmit={sendTestEmail}
          aria-busy={pending === 'send'}
        >
          <div className="admin-mail-send-controls">
            <Field label="测试收件邮箱" hint="仅在点击发送后向此地址发送一封测试邮件。">
              <input
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="yourname@example.com"
                value={testEmail}
                disabled={pending === 'send'}
                onChange={(event) => {
                  setTestEmail(event.target.value);
                  setSendError('');
                  setSendResult('');
                }}
              />
            </Field>
            <Button
              type="submit"
              loading={pending === 'send'}
              disabled={dirty || !complete || !testEmail.trim() || pending !== null}
            >
              <Send size={16} />
              发送测试邮件
            </Button>
          </div>
          <p className="admin-mail-send-note">
            {dirty
              ? 'SMTP 配置有未保存的更改，请先保存后再发送。'
              : !complete
                ? '请先保存完整的 SMTP 主机与发件邮箱。'
                : '服务器接受邮件后仍可能延迟、退信或进入垃圾邮件。连接测试成功不能替代实际发信测试。'}
          </p>
          <MailError error={sendError} />
          {sendResult && !dirty && (
            <div className="admin-embedding-success admin-mail-send-result" role="status">
              <CheckCircle2 size={17} />
              <span>{sendResult}</span>
            </div>
          )}
        </form>
      </section>
      <MailDeliveryLog refreshKey={deliveryRefresh} />
      <form
        className="admin-settings-form admin-mail-policy"
        onSubmit={savePolicy}
        aria-busy={policyPending}
      >
        <fieldset className="admin-mail-policy-fields" disabled={policyPending}>
          <section className="admin-settings-section">
            <div className="admin-settings-description">
              <span className="admin-settings-index">01</span>
              <h3>注册邮箱策略</h3>
              <p>邮箱验证为可选功能。域名规则独立生效，不会改变已有账户。</p>
            </div>
            <div className="admin-settings-fields">
              <MailToggle
                label="注册时验证邮箱"
                description="开启后，新用户需要填写发送到注册邮箱的验证码。"
                value={requireVerification}
                onChange={setRequireVerification}
              />
              {requireVerification && !complete && (
                <div className="admin-small-notice">
                  <AlertCircle size={17} />
                  请先保存完整的 SMTP 主机和发件邮箱，再开启此选项。
                </div>
              )}
              <Field label="邮箱域名规则">
                <Select
                  disabled={policyPending}
                  value={domainMode}
                  onValueChange={(value) =>
                    setDomainMode(value as PlatformSettings['emailDomainMode'])
                  }
                >
                  <option value="any">允许任意邮箱域名</option>
                  <option value="allowlist">仅允许指定域名</option>
                  <option value="blocklist">禁止指定域名</option>
                </Select>
              </Field>
              <Field
                label="邮箱域名列表"
                hint={`每行一个域名，最多 100 条，当前 ${domains.length} 条。保存时会去重并规范化国际化域名。`}
              >
                <textarea
                  rows={5}
                  maxLength={26000}
                  disabled={domainMode === 'any'}
                  placeholder={'example.com\n*.example.org'}
                  value={domainsText}
                  onChange={(event) => setDomainsText(event.target.value)}
                />
              </Field>
              <p className="admin-field-note">
                example.com 仅匹配该域名；*.example.com
                仅匹配子域名，不包含根域名。支持国际化域名，请勿填写邮箱地址、网址或路径。
              </p>
              <MailError error={policyError} />
            </div>
          </section>
          <div className="admin-settings-footer">
            <span>{policyDirty ? '注册策略有尚未保存的更改' : '注册策略已保存'}</span>
            <Button type="submit" loading={policyPending} disabled={!policyDirty}>
              <Check size={16} />
              保存注册策略
            </Button>
          </div>
        </fieldset>
      </form>
      <div className="admin-info-line">
        <LockKeyhole size={16} />
        <p>
          SMTP 密码在服务端加密保存，不会返回浏览器。测试连接与发送注册验证码使用已保存的邮件配置。
        </p>
      </div>
    </div>
  );
}
