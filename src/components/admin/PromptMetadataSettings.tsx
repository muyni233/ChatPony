'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Eye, LoaderCircle } from 'lucide-react';
import { Select } from '@/components/select';
import { api } from '@/lib/client';
import type { PromptMetadataOptions } from '@/lib/prompt-metadata';

export function metadataDefaults(
  settings: Partial<PromptMetadataOptions> = {},
): PromptMetadataOptions {
  return {
    promptMetadataEnabled: settings.promptMetadataEnabled ?? false,
    promptTimezone: settings.promptTimezone ?? 'Asia/Shanghai',
    promptIncludeDate: settings.promptIncludeDate ?? true,
    promptIncludeTime: settings.promptIncludeTime ?? true,
    promptIncludeWeekday: settings.promptIncludeWeekday ?? true,
    promptIncludeLunarDate: settings.promptIncludeLunarDate ?? false,
    promptIncludeSolarTerm: settings.promptIncludeSolarTerm ?? true,
    promptIncludeHolidays: settings.promptIncludeHolidays ?? true,
  };
}

const timezones = [
  ['Asia/Shanghai', '中国标准时间 · Asia/Shanghai'],
  ['Asia/Hong_Kong', '香港 · Asia/Hong_Kong'],
  ['Asia/Taipei', '台北 · Asia/Taipei'],
  ['Asia/Tokyo', '东京 · Asia/Tokyo'],
  ['Asia/Singapore', '新加坡 · Asia/Singapore'],
  ['Europe/London', '伦敦 · Europe/London'],
  ['Europe/Paris', '巴黎 · Europe/Paris'],
  ['America/New_York', '纽约 · America/New_York'],
  ['America/Los_Angeles', '洛杉矶 · America/Los_Angeles'],
  ['Australia/Sydney', '悉尼 · Australia/Sydney'],
  ['UTC', '协调世界时 · UTC'],
] as const;

const fields = [
  { key: 'promptIncludeDate', id: 'date', label: '日期', hint: '公历年月日' },
  { key: 'promptIncludeTime', id: 'time', label: '时间', hint: '时分，24 小时制' },
  { key: 'promptIncludeWeekday', id: 'weekday', label: '星期', hint: '星期一至星期日' },
  { key: 'promptIncludeLunarDate', id: 'lunar', label: '农历', hint: '中国农历年月日' },
  {
    key: 'promptIncludeSolarTerm',
    id: 'solar-term',
    label: '当前节气',
    hint: '当前节气与交节提示',
  },
  { key: 'promptIncludeHolidays', id: 'holidays', label: '节日', hint: '当天的传统与公历节日' },
] as const;

function timezoneValidation(value: string) {
  const timezone = value.trim();
  if (!timezone) return '请输入 IANA 时区，例如 Asia/Shanghai。';
  if (timezone.length > 100 || /^[+-]/.test(timezone)) return '请输入有效的 IANA 时区名称。';
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format();
    return '';
  } catch {
    return '无法识别此时区，请检查 IANA 名称，例如 Europe/Berlin。';
  }
}

interface Props {
  value: PromptMetadataOptions;
  onChange: (value: PromptMetadataOptions) => void;
  disabled?: boolean;
}

interface Preview {
  text: string;
  generatedAt: string;
}

export default function PromptMetadataSettings({ value, onChange, disabled = false }: Props) {
  const [customTimezone, setCustomTimezone] = useState(
    !timezones.some(([timezone]) => timezone === value.promptTimezone),
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const request = useRef<AbortController | null>(null);
  const timezoneError = timezoneValidation(value.promptTimezone);
  const selected = fields.filter((field) => value[field.key]).length;

  useEffect(() => () => request.current?.abort(), []);

  function update(patch: Partial<PromptMetadataOptions>) {
    request.current?.abort();
    request.current = null;
    setPreviewBusy(false);
    setPreview(null);
    setPreviewError('');
    onChange({ ...value, ...patch });
  }

  async function loadPreview() {
    if (!value.promptMetadataEnabled || timezoneError || disabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setPreviewBusy(true);
    setPreviewError('');
    setPreview(null);
    try {
      const result = await api<Preview>('/api/admin/settings/preview-metadata', {
        method: 'POST',
        body: JSON.stringify({ ...value, promptTimezone: value.promptTimezone.trim() }),
        signal: controller.signal,
      });
      if (request.current === controller) setPreview(result);
    } catch (cause) {
      if (request.current === controller) {
        setPreviewError(
          controller.signal.aborted
            ? '预览请求超时，请重试。'
            : cause instanceof Error
              ? cause.message
              : '预览加载失败，请重试。',
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setPreviewBusy(false);
      }
    }
  }

  return (
    <section
      className="admin-site-section admin-metadata-section"
      aria-labelledby="metadata-heading"
    >
      <div className="admin-section-heading">
        <div>
          <span className="eyebrow">05 / TIME & CALENDAR</span>
          <h2 id="metadata-heading">时间与日历信息</h2>
          <p>为角色补充现实时间背景，按需加入系统提示词。</p>
        </div>
        <CalendarDays size={20} color="#91a779" />
      </div>
      <div className="account-form">
        <label className="admin-checkbox metadata-master-switch">
          <input
            id="site-prompt-metadata-enabled"
            name="promptMetadataEnabled"
            type="checkbox"
            checked={value.promptMetadataEnabled}
            disabled={disabled}
            onChange={(event) => update({ promptMetadataEnabled: event.target.checked })}
          />
          <span>
            <strong>注入时间与日历信息</strong>
            <small>默认关闭。开启并保存后，在每轮对话中补充所选信息。</small>
          </span>
        </label>
        <div className="metadata-timezone-fields">
          <label className="field" htmlFor="site-prompt-timezone">
            <span>日期与时间的时区</span>
            <Select
              id="site-prompt-timezone"
              aria-label="日期与时间的时区"
              value={customTimezone ? 'custom' : value.promptTimezone}
              disabled={disabled}
              onValueChange={(timezone) => {
                setCustomTimezone(timezone === 'custom');
                if (timezone !== 'custom') update({ promptTimezone: timezone });
              }}
            >
              {timezones.map(([timezone, label]) => (
                <option key={timezone} value={timezone}>
                  {label}
                </option>
              ))}
              <option value="custom">自定义 IANA 时区</option>
            </Select>
            <small className="field-hint">日期、时间与星期按该时区生成，自动遵循当地夏令时。</small>
          </label>
          {customTimezone && (
            <label className="field" htmlFor="site-prompt-timezone-custom">
              <span>自定义时区名称</span>
              <input
                id="site-prompt-timezone-custom"
                name="promptTimezone"
                value={value.promptTimezone}
                disabled={disabled}
                required
                maxLength={100}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="例如 Europe/Berlin"
                aria-invalid={!!timezoneError}
                aria-describedby="metadata-timezone-hint"
                onChange={(event) => {
                  event.currentTarget.setCustomValidity(timezoneValidation(event.target.value));
                  update({ promptTimezone: event.target.value });
                }}
              />
              <small
                id="metadata-timezone-hint"
                className={`field-hint${timezoneError ? ' metadata-field-error' : ''}`}
                role={timezoneError ? 'alert' : undefined}
              >
                {timezoneError || '填写 IANA 时区名称，不使用 UTC+8 等固定偏移写法。'}
              </small>
            </label>
          )}
        </div>
        <fieldset className="metadata-options" disabled={disabled}>
          <legend>包含的信息</legend>
          <div>
            {fields.map((field) => (
              <label key={field.key} className="admin-checkbox">
                <input
                  id={`site-prompt-${field.id}`}
                  name={field.key}
                  type="checkbox"
                  checked={value[field.key]}
                  onChange={(event) => update({ [field.key]: event.target.checked })}
                />
                <span>
                  <strong>{field.label}</strong>
                  <small>{field.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="metadata-context-note">
          <p>农历、节气与节日统一采用中国历法（Asia/Shanghai）。节日信息不包含法定调休表。</p>
          <p>角色或场景中明确的时间设定优先；现实时间仅作背景参考，不要求角色每句回复报时。</p>
        </div>
        <div className="metadata-preview" aria-label="时间与日历注入预览" aria-busy={previewBusy}>
          <header>
            <div>
              <span>注入内容预览</span>
              <small>使用当前未保存的配置，不会保存设置</small>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void loadPreview()}
              disabled={disabled || previewBusy || !value.promptMetadataEnabled || !!timezoneError}
            >
              {previewBusy ? <LoaderCircle className="spin" size={14} /> : <Eye size={14} />}
              {previewBusy ? '正在生成预览…' : '预览注入内容'}
            </button>
          </header>
          <div className="metadata-preview-body" aria-live="polite">
            {!value.promptMetadataEnabled ? (
              <p className="metadata-preview-empty">已关闭，不注入</p>
            ) : previewBusy ? (
              <p className="metadata-preview-empty">正在按当前配置生成预览…</p>
            ) : previewError ? (
              <p className="metadata-preview-error" role="alert">
                {previewError}
              </p>
            ) : preview ? (
              <>
                {preview.text ? (
                  <pre>{preview.text}</pre>
                ) : (
                  <p className="metadata-preview-empty">未选择任何信息，不注入</p>
                )}
                <small className="metadata-preview-timestamp">
                  生成于{' '}
                  <time dateTime={preview.generatedAt}>
                    {new Date(preview.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
                  </time>{' '}
                  · 下次对话时会重新获取
                </small>
              </>
            ) : (
              <p className="metadata-preview-empty">
                {selected ? '点击预览，查看按当前设置生成的注入内容。' : '未选择任何信息，不注入'}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
