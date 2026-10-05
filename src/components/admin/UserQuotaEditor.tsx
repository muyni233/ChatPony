'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Info, LoaderCircle, Save } from 'lucide-react';
import { api } from '@/lib/client';
import { Select } from '@/components/select';
import Dialog from './Dialog';

export interface QuotaMember {
  id: string;
  username: string;
  quota5h?: number | null;
  quota1d?: number | null;
  quota7d?: number | null;
  quota5hEnabled?: boolean | null;
  quota1dEnabled?: boolean | null;
  quota7dEnabled?: boolean | null;
}

type Defaults = {
  quota5h: number;
  quota1d: number;
  quota7d: number;
  quota5hEnabled: boolean;
  quota1dEnabled: boolean;
  quota7dEnabled: boolean;
};
const windows = [
  { key: '5h', tag: '5H', duration: '5 小时', limitKey: 'quota5h', enabledKey: 'quota5hEnabled' },
  { key: '1d', tag: '1D', duration: '1 天', limitKey: 'quota1d', enabledKey: 'quota1dEnabled' },
  { key: '7d', tag: '7D', duration: '7 天', limitKey: 'quota7d', enabledKey: 'quota7dEnabled' },
] as const;
const setting = (value: boolean | null | undefined) =>
  value == null ? 'inherit' : value ? 'enabled' : 'disabled';

export default function UserQuotaEditor({
  member,
  onClose,
  onSaved,
}: {
  member: QuotaMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [limits, setLimits] = useState({
    quota5h: member.quota5h == null ? '' : String(member.quota5h),
    quota1d: member.quota1d == null ? '' : String(member.quota1d),
    quota7d: member.quota7d == null ? '' : String(member.quota7d),
  });
  const [switches, setSwitches] = useState({
    quota5hEnabled: setting(member.quota5hEnabled),
    quota1dEnabled: setting(member.quota1dEnabled),
    quota7dEnabled: setting(member.quota7dEnabled),
  });
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ settings: Partial<Defaults> }>('/api/admin/settings')
      .then((result) => {
        if (active)
          setDefaults({
            quota5h: result.settings.quota5h ?? 50,
            quota1d: result.settings.quota1d ?? 100,
            quota7d: result.settings.quota7d ?? 500,
            quota5hEnabled: result.settings.quota5hEnabled ?? true,
            quota1dEnabled: result.settings.quota1dEnabled ?? false,
            quota7dEnabled: result.settings.quota7dEnabled ?? true,
          });
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : '默认配额加载失败，请重试。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.values(limits).map((value) =>
      value.trim() === '' ? null : Number(value),
    );
    if (
      values.some(
        (value) => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1000000),
      )
    ) {
      setError('配额应为 0—1,000,000 的整数；留空继承站点默认。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = {
        ...Object.fromEntries(
          Object.entries(limits).map(([key, value]) => [
            key,
            value.trim() === '' ? null : Number(value),
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(switches).map(([key, value]) => [
            key,
            value === 'inherit' ? null : value === 'enabled',
          ]),
        ),
      };
      await api(`/api/admin/users/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      window.dispatchEvent(new Event('chatpony:quota'));
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用户配额保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="调整用户配额"
      description={`为「${member.username}」设置 AI 对话次数。`}
      onClose={onClose}
      busy={busy}
    >
      <form className="account-form admin-editor-form admin-quota-editor" onSubmit={save}>
        {loading ? (
          <div className="quota-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            正在读取站点默认配额…
          </div>
        ) : (
          defaults && (
            <>
              <div className="admin-quota-inheritance">
                <span>站点默认</span>
                {windows.map((window) => (
                  <strong key={window.key}>
                    <b>{window.tag}</b>{' '}
                    {defaults[window.enabledKey]
                      ? `${defaults[window.limitKey].toLocaleString()} 次`
                      : '未启用'}
                  </strong>
                ))}
              </div>
              {windows.map((window) => (
                <div className="admin-user-window" key={window.key}>
                  <header>
                    <span className="quota-window-tag">{window.tag}</span>
                    <strong>{window.duration}配额</strong>
                  </header>
                  <div className="form-grid">
                    <label className="field" htmlFor={`user-quota-${window.key}-state`}>
                      <span>是否启用</span>
                      <Select
                        id={`user-quota-${window.key}-state`}
                        aria-label={`${window.duration}配额开关`}
                        value={switches[window.enabledKey]}
                        onValueChange={(value) =>
                          setSwitches((previous) => ({ ...previous, [window.enabledKey]: value }))
                        }
                        disabled={busy}
                      >
                        <option value="inherit">继承站点</option>
                        <option value="enabled">启用</option>
                        <option value="disabled">停用</option>
                      </Select>
                      <small className="field-hint">
                        站点当前{defaults[window.enabledKey] ? '启用' : '未启用'}此窗口
                      </small>
                    </label>
                    <label className="field" htmlFor={`user-quota-${window.key}`}>
                      <span>次数上限</span>
                      <input
                        id={`user-quota-${window.key}`}
                        name={window.limitKey}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={1000000}
                        step={1}
                        value={limits[window.limitKey]}
                        onChange={(event) =>
                          setLimits((previous) => ({
                            ...previous,
                            [window.limitKey]: event.target.value,
                          }))
                        }
                        placeholder={`继承站点：${defaults[window.limitKey]}`}
                        disabled={busy}
                      />
                      <small className="field-hint">
                        {limits[window.limitKey] === ''
                          ? '跟随站点默认配额'
                          : '使用该用户的独立配额'}
                      </small>
                    </label>
                  </div>
                </div>
              ))}
              <div className="admin-quota-help">
                <Info size={16} />
                <p>
                  开关与次数分别继承。已启用的窗口同时生效，启用且设为 0 时暂停 AI
                  回复。调整配置不会重置已经使用的次数。
                </p>
              </div>
            </>
          )
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {!loading && !defaults && (
          <button
            className="button button-secondary"
            type="button"
            onClick={() => {
              setLoading(true);
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            重新加载
          </button>
        )}
        <footer className="admin-dialog-footer">
          <span>保存后立即生效</span>
          <div>
            <button
              className="button button-secondary"
              type="button"
              data-dialog-close
              disabled={busy}
            >
              取消
            </button>
            <button
              className="button button-primary"
              type="submit"
              disabled={busy || loading || !defaults}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              {busy ? '保存中…' : '保存配额'}
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}
