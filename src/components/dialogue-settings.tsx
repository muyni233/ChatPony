'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, BookHeart, CalendarDays, Check, Cpu, Layers3 } from 'lucide-react';
import { useApp } from '@/components/app-provider';
import { Button, Field, Select } from '@/components/ui';
import { api, json } from '@/lib/client';
import type { PlatformSettings, ProviderConfig } from '@/lib/types';

type Compression = Pick<
  PlatformSettings,
  'compressionTriggerRounds' | 'compressionKeepRounds' | 'compressionModelId'
>;
type MemoryPolicy = Pick<
  PlatformSettings,
  'automaticMemoryEnabled' | 'memorySummaryInterval' | 'memorySummaryModelId'
>;
type Metadata = Pick<
  PlatformSettings,
  'metadataEnabled' | 'metadataFields' | 'metadataTimezone' | 'metadataCustom'
>;
type Group = 'compression' | 'memory' | 'metadata';
const metadataOptions = [
  { id: 'date', label: '日期', hint: '当前年月日' },
  { id: 'time', label: '时间', hint: '当前时分秒' },
  { id: 'weekday', label: '星期', hint: '当前星期几' },
  { id: 'timezone', label: '时区', hint: 'IANA 时区名称' },
  { id: 'lunarDate', label: '农历', hint: '农历日期' },
  { id: 'solarTermToday', label: '今日节气', hint: '当日交节信息' },
  { id: 'solarTermSeason', label: '当前节气', hint: '当前所处节气' },
  { id: 'festivals', label: '节日', hint: '公历与农历节日' },
] as const;

function ModelChoice({
  label,
  value,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  models: ProviderConfig[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const available = models.filter(
    (model) => model.kind === 'language' && model.active && model.supplierActive,
  );
  return (
    <Field
      label={label}
      hint="选择语言模型会生成语义摘要；原文截取只裁剪历史片段，不理解内容，可能遗漏信息。"
    >
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <option value="">原文截取（不调用模型）</option>
        {value && !available.some((model) => model.id === value) && (
          <option value={value} disabled>
            原模型已不可用，请重新选择
          </option>
        )}
        {available.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} · {model.model}
            {model.supplierName ? `（${model.supplierName}）` : ''}
          </option>
        ))}
      </Select>
    </Field>
  );
}
function PolicyToggle({
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
        type="checkbox"
        className="admin-toggle"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="admin-toggle-track" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}
function PolicyError({ error }: { error: string }) {
  return error ? (
    <div className="admin-error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}

export function DialogueSettings({
  settings,
  models,
  onChanged,
}: {
  settings: PlatformSettings;
  models: ProviderConfig[];
  onChanged: () => Promise<void>;
}) {
  const { notify } = useApp();
  const savedCompression = JSON.stringify({
    compressionTriggerRounds: settings.compressionTriggerRounds,
    compressionKeepRounds: settings.compressionKeepRounds,
    compressionModelId: settings.compressionModelId,
  });
  const savedMemory = JSON.stringify({
    automaticMemoryEnabled: settings.automaticMemoryEnabled,
    memorySummaryInterval: settings.memorySummaryInterval,
    memorySummaryModelId: settings.memorySummaryModelId,
  });
  const savedMetadata = JSON.stringify({
    metadataEnabled: settings.metadataEnabled,
    metadataFields: settings.metadataFields,
    metadataTimezone: settings.metadataTimezone,
    metadataCustom: settings.metadataCustom,
  });
  const [compression, setCompression] = useState<Compression>(() => JSON.parse(savedCompression));
  const [memory, setMemory] = useState<MemoryPolicy>(() => JSON.parse(savedMemory));
  const [metadata, setMetadata] = useState<Metadata>(() => JSON.parse(savedMetadata));
  const [pending, setPending] = useState<Group | null>(null);
  const [errors, setErrors] = useState<Record<Group, string>>({
    compression: '',
    memory: '',
    metadata: '',
  });
  useEffect(() => setCompression(JSON.parse(savedCompression)), [savedCompression]);
  useEffect(() => setMemory(JSON.parse(savedMemory)), [savedMemory]);
  useEffect(() => setMetadata(JSON.parse(savedMetadata)), [savedMetadata]);
  const compressionDirty = JSON.stringify(compression) !== savedCompression;
  const memoryDirty = JSON.stringify(memory) !== savedMemory;
  const metadataDirty = JSON.stringify(metadata) !== savedMetadata;

  async function save(event: FormEvent, group: Group) {
    event.preventDefault();
    if (pending) return;
    setErrors((previous) => ({ ...previous, [group]: '' }));
    if (
      group === 'compression' &&
      compression.compressionKeepRounds >= compression.compressionTriggerRounds
    ) {
      setErrors((previous) => ({
        ...previous,
        compression: '保留的最近轮数必须小于触发压缩的轮数。',
      }));
      return;
    }
    if (group === 'metadata' && metadata.metadataTimezone.trim()) {
      try {
        new Intl.DateTimeFormat('zh-CN', { timeZone: metadata.metadataTimezone.trim() }).format(
          new Date(),
        );
      } catch {
        setErrors((previous) => ({
          ...previous,
          metadata: '请输入有效的 IANA 时区，例如 Asia/Shanghai，或留空使用用户时区。',
        }));
        return;
      }
    }
    setPending(group);
    try {
      const payload =
        group === 'compression'
          ? compression
          : group === 'memory'
            ? memory
            : { ...metadata, metadataTimezone: metadata.metadataTimezone.trim() };
      await api<PlatformSettings>('/api/admin/settings', json('PATCH', payload));
      await onChanged();
      notify(
        group === 'compression'
          ? '上下文策略已保存'
          : group === 'memory'
            ? '记忆策略已保存'
            : '元数据设置已保存',
        'success',
      );
    } catch (reason) {
      setErrors((previous) => ({
        ...previous,
        [group]: reason instanceof Error ? reason.message : '保存失败，请稍后重试。',
      }));
    } finally {
      setPending(null);
    }
  }

  function selectMetadata(id: string, selected: boolean) {
    setMetadata((previous) => {
      const fields = new Set(previous.metadataFields);
      if (selected) fields.add(id);
      else fields.delete(id);
      return {
        ...previous,
        metadataFields: metadataOptions
          .filter((option) => fields.has(option.id))
          .map((option) => option.id),
      };
    });
  }

  return (
    <div className="admin-dialogue-page">
      <div className="admin-section-title">
        <div>
          <span className="admin-eyebrow">CONVERSATION POLICIES</span>
          <h2>对话策略</h2>
          <p>分别管理上下文整理、长期记忆提炼与元数据注入。</p>
        </div>
      </div>
      <div className="admin-dialogue-call-note">
        <Cpu size={18} />
        <p>
          选择语言模型后，由该模型理解并总结历史内容；调用会记录在请求审查中，不计入角色对话额度。“原文截取”只保留部分历史原文，不生成语义摘要。
        </p>
      </div>
      <div className="admin-dialogue-sections">
        <form
          className="admin-settings-form admin-dialogue-form"
          onSubmit={(event) => void save(event, 'compression')}
          aria-busy={pending === 'compression'}
        >
          <fieldset className="admin-dialogue-fieldset" disabled={pending !== null}>
            <section className="admin-settings-section">
              <div className="admin-settings-description">
                <span className="admin-dialogue-section-icon">
                  <Layers3 size={20} />
                </span>
                <h3>上下文压缩</h3>
                <p>按用户发言轮数触发整理，同时保留最近的对话上下文。</p>
              </div>
              <div className="admin-settings-fields">
                <div className="admin-form-grid">
                  <Field label="触发压缩轮数" hint="允许 2–200 轮，按用户发言计数。">
                    <input
                      type="number"
                      required
                      min={2}
                      max={200}
                      step={1}
                      value={compression.compressionTriggerRounds}
                      onChange={(event) =>
                        setCompression((previous) => ({
                          ...previous,
                          compressionTriggerRounds: Number(event.target.value),
                        }))
                      }
                    />
                  </Field>
                  <Field label="保留最近轮数" hint="允许 1–50 轮，必须小于触发轮数。">
                    <input
                      type="number"
                      required
                      min={1}
                      max={50}
                      step={1}
                      value={compression.compressionKeepRounds}
                      onChange={(event) =>
                        setCompression((previous) => ({
                          ...previous,
                          compressionKeepRounds: Number(event.target.value),
                        }))
                      }
                    />
                  </Field>
                </div>
                <ModelChoice
                  label="上下文摘要模型"
                  value={compression.compressionModelId}
                  models={models}
                  disabled={pending !== null}
                  onChange={(value) =>
                    setCompression((previous) => ({ ...previous, compressionModelId: value }))
                  }
                />
                <div className="admin-small-notice">
                  <Layers3 size={17} />
                  接近模型上下文上限时，系统仍会提前进行必要整理。原始对话消息会完整保留。
                </div>
                <PolicyError error={errors.compression} />
              </div>
            </section>
            <div className="admin-settings-footer">
              <span>{compressionDirty ? '上下文策略有尚未保存的更改' : '上下文策略已保存'}</span>
              <Button
                type="submit"
                disabled={!compressionDirty || (pending !== null && pending !== 'compression')}
                loading={pending === 'compression'}
              >
                <Check size={16} />
                保存上下文策略
              </Button>
            </div>
          </fieldset>
        </form>
        <form
          className="admin-settings-form admin-dialogue-form"
          onSubmit={(event) => void save(event, 'memory')}
          aria-busy={pending === 'memory'}
        >
          <fieldset className="admin-dialogue-fieldset" disabled={pending !== null}>
            <section className="admin-settings-section">
              <div className="admin-settings-description">
                <span className="admin-dialogue-section-icon admin-dialogue-icon-pink">
                  <BookHeart size={20} />
                </span>
                <h3>长期记忆提炼</h3>
                <p>按用户与角色分别整理长期记忆，保持记忆的归属范围。</p>
              </div>
              <div className="admin-settings-fields">
                <PolicyToggle
                  label="自动提炼长期记忆"
                  description="开启后，系统会从对话中提炼可保留的事实。关闭后仍可手动管理记忆。"
                  value={memory.automaticMemoryEnabled}
                  onChange={(value) =>
                    setMemory((previous) => ({ ...previous, automaticMemoryEnabled: value }))
                  }
                />
                <Field
                  label="记忆汇总间隔"
                  hint="允许 1–100 次，按该用户与角色之间成功的角色回复计数。"
                >
                  <input
                    type="number"
                    required
                    min={1}
                    max={100}
                    step={1}
                    value={memory.memorySummaryInterval}
                    onChange={(event) =>
                      setMemory((previous) => ({
                        ...previous,
                        memorySummaryInterval: Number(event.target.value),
                      }))
                    }
                  />
                </Field>
                <ModelChoice
                  label="记忆摘要模型"
                  value={memory.memorySummaryModelId}
                  models={models}
                  disabled={pending !== null}
                  onChange={(value) =>
                    setMemory((previous) => ({ ...previous, memorySummaryModelId: value }))
                  }
                />
                <div className="admin-small-notice">
                  <BookHeart size={17} />
                  开启自动记忆后，明确要求记住的事实会及时记录，不必等待汇总周期。
                </div>
                <PolicyError error={errors.memory} />
              </div>
            </section>
            <div className="admin-settings-footer">
              <span>{memoryDirty ? '记忆策略有尚未保存的更改' : '记忆策略已保存'}</span>
              <Button
                type="submit"
                disabled={!memoryDirty || (pending !== null && pending !== 'memory')}
                loading={pending === 'memory'}
              >
                <Check size={16} />
                保存记忆策略
              </Button>
            </div>
          </fieldset>
        </form>
        <form
          className="admin-settings-form admin-dialogue-form"
          onSubmit={(event) => void save(event, 'metadata')}
          aria-busy={pending === 'metadata'}
        >
          <fieldset className="admin-dialogue-fieldset" disabled={pending !== null}>
            <section className="admin-settings-section">
              <div className="admin-settings-description">
                <span className="admin-dialogue-section-icon admin-dialogue-icon-gold">
                  <CalendarDays size={20} />
                </span>
                <h3>元数据注入</h3>
                <p>选择要提供给角色的环境信息，并按需设置统一时区与补充文本。</p>
              </div>
              <div className="admin-settings-fields">
                <PolicyToggle
                  label="启用元数据注入"
                  description="按选择的项目生成日期、时间、节气与节日等信息。"
                  value={metadata.metadataEnabled}
                  onChange={(value) =>
                    setMetadata((previous) => ({ ...previous, metadataEnabled: value }))
                  }
                />
                <div className="admin-metadata-options" role="group" aria-label="元数据项目">
                  {metadataOptions.map((option) => (
                    <label
                      key={option.id}
                      className={`admin-metadata-option ${metadata.metadataFields.includes(option.id) ? 'is-selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={metadata.metadataFields.includes(option.id)}
                        onChange={(event) => selectMetadata(option.id, event.target.checked)}
                      />
                      <span className="admin-metadata-check" aria-hidden="true">
                        <Check size={12} />
                      </span>
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.hint}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <Field
                  label="统一元数据时区"
                  hint="可选，填写 IANA 时区；留空时使用当前用户的账户时区。"
                >
                  <input
                    maxLength={100}
                    placeholder="例如：Asia/Shanghai"
                    value={metadata.metadataTimezone}
                    onChange={(event) =>
                      setMetadata((previous) => ({
                        ...previous,
                        metadataTimezone: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="补充元数据"
                  hint={`${metadata.metadataCustom.length} / 2,000 字，以纯文本注入，不执行模板或代码。`}
                >
                  <textarea
                    rows={5}
                    maxLength={2000}
                    placeholder="输入需要统一提供给角色的补充信息…"
                    value={metadata.metadataCustom}
                    onChange={(event) =>
                      setMetadata((previous) => ({
                        ...previous,
                        metadataCustom: event.target.value,
                      }))
                    }
                  />
                </Field>
                <PolicyError error={errors.metadata} />
              </div>
            </section>
            <div className="admin-settings-footer">
              <span>{metadataDirty ? '元数据设置有尚未保存的更改' : '元数据设置已保存'}</span>
              <Button
                type="submit"
                disabled={!metadataDirty || (pending !== null && pending !== 'metadata')}
                loading={pending === 'metadata'}
              >
                <Check size={16} />
                保存元数据设置
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
