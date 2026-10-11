import { Solar } from 'lunar-javascript';
import type { PlatformSettings } from '../types';

export function buildMetadataInjection(
  settings: Pick<
    PlatformSettings,
    'metadataEnabled' | 'metadataFields' | 'metadataTimezone' | 'metadataCustom'
  >,
  userTimezone: string,
  date = new Date(),
): string {
  if (settings.metadataEnabled === false) return '';
  const allowed = [
    'date',
    'time',
    'weekday',
    'timezone',
    'lunarDate',
    'solarTermToday',
    'solarTermSeason',
    'festivals',
  ] as const;
  const selected = settings.metadataFields ?? [...allowed];
  const metadata = buildMetadata(settings.metadataTimezone?.trim() || userTimezone, date);
  const data: Record<string, unknown> = {};
  for (const key of allowed) if (selected.includes(key)) data[key] = metadata[key];
  if (
    selected.some((key) =>
      ['lunarDate', 'solarTermToday', 'solarTermSeason', 'festivals'].includes(key),
    )
  )
    data.calendarNote = metadata.calendarNote;
  if (settings.metadataCustom?.trim()) data.custom = settings.metadataCustom.trim();
  return Object.keys(data).length ? `当前元数据：${JSON.stringify(data)}` : '';
}

export function buildMetadata(timezone: string, date = new Date()) {
  let zone = timezone;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(date);
  } catch {
    zone = 'Asia/Shanghai';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const solar = Solar.fromYmdHms(
    Number(fields.year),
    Number(fields.month),
    Number(fields.day),
    Number(fields.hour),
    Number(fields.minute),
    Number(fields.second),
  );
  const lunar = solar.getLunar();
  return {
    timezone: zone,
    date: `${fields.year}-${fields.month}-${fields.day}`,
    time: `${fields.hour}:${fields.minute}:${fields.second}`,
    weekday: new Intl.DateTimeFormat('zh-CN', { timeZone: zone, weekday: 'long' }).format(date),
    lunarDate: lunar.toString(),
    solarTermToday: lunar.getJieQi() || '无',
    solarTermSeason: lunar.getPrevJieQi(true).getName(),
    festivals: [...new Set([...solar.getFestivals(), ...lunar.getFestivals()])],
    calendarNote: '中国传统农历与节气；节日是历法纪念日，不代表法定放假安排。',
  };
}
