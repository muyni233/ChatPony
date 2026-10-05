import calendar from 'lunar-javascript';

export interface PromptMetadataOptions {
  promptMetadataEnabled: boolean;
  promptTimezone: string;
  promptIncludeDate: boolean;
  promptIncludeTime: boolean;
  promptIncludeWeekday: boolean;
  promptIncludeLunarDate: boolean;
  promptIncludeSolarTerm: boolean;
  promptIncludeHolidays: boolean;
}

export const DEFAULT_PROMPT_METADATA_OPTIONS: Readonly<PromptMetadataOptions> = Object.freeze({
  promptMetadataEnabled: false,
  promptTimezone: 'Asia/Shanghai',
  promptIncludeDate: true,
  promptIncludeTime: true,
  promptIncludeWeekday: true,
  promptIncludeLunarDate: false,
  promptIncludeSolarTerm: true,
  promptIncludeHolidays: true,
});

const booleanFields = [
  'promptMetadataEnabled',
  'promptIncludeDate',
  'promptIncludeTime',
  'promptIncludeWeekday',
  'promptIncludeLunarDate',
  'promptIncludeSolarTerm',
  'promptIncludeHolidays',
] as const;

export class PromptMetadataValidationError extends Error {
  readonly code = 'INVALID_PROMPT_METADATA';

  constructor(message: string) {
    super(message);
    this.name = 'PromptMetadataValidationError';
  }
}

/** Read only the metadata fields, so a complete site-settings PATCH is valid. */
export function validatePromptMetadataOptions(
  input: unknown,
  base: PromptMetadataOptions = DEFAULT_PROMPT_METADATA_OPTIONS,
): PromptMetadataOptions {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PromptMetadataValidationError('时间信息设置需要使用有效的配置对象。');
  }
  const data = input as Record<string, unknown>;
  const result: PromptMetadataOptions = { ...DEFAULT_PROMPT_METADATA_OPTIONS };
  for (const field of booleanFields) {
    const inherited = base[field] === undefined ? result[field] : base[field];
    const value = data[field] === undefined ? inherited : data[field];
    if (typeof value !== 'boolean')
      throw new PromptMetadataValidationError('请选择有效的时间信息开关。');
    result[field] = value;
  }
  const timezone =
    data.promptTimezone === undefined
      ? (base.promptTimezone ?? result.promptTimezone)
      : data.promptTimezone;
  // Intl also accepts numeric UTC offsets on newer runtimes; require a named
  // IANA zone so daylight-saving transitions remain defined by the zone data.
  if (
    typeof timezone !== 'string' ||
    timezone.trim().length > 100 ||
    !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(timezone.trim())
  ) {
    throw new PromptMetadataValidationError(
      '请填写有效的 IANA 时区，例如 Asia/Shanghai 或 America/New_York。',
    );
  }
  try {
    result.promptTimezone = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone.trim(),
    }).resolvedOptions().timeZone;
  } catch {
    throw new PromptMetadataValidationError(
      '请填写有效的 IANA 时区，例如 Asia/Shanghai 或 America/New_York。',
    );
  }
  return result;
}

function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('zh-CN-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
    weekday: value('weekday'),
  };
}

/** Pure calendar data. Callers should reuse one Date for every role in a turn. */
export function buildPromptMetadata(
  options?: Partial<PromptMetadataOptions> | null,
  now: Date = new Date(),
): string {
  const settings = validatePromptMetadataOptions(options ?? {});
  if (!settings.promptMetadataEnabled || !booleanFields.slice(1).some((field) => settings[field]))
    return '';
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new RangeError('无法为无效的日期生成时间信息。');

  const lines = [
    '[现实时间参考]',
    '以下为现实时间参考；场景明确设定时间时以场景为准，不需要在每次回复中复述。',
  ];
  if (settings.promptIncludeDate || settings.promptIncludeTime || settings.promptIncludeWeekday) {
    const local = localParts(now, settings.promptTimezone);
    lines.push(`站点时区：${settings.promptTimezone}`);
    if (settings.promptIncludeDate)
      lines.push(`日期：${local.year.padStart(4, '0')}-${local.month}-${local.day}`);
    if (settings.promptIncludeTime) lines.push(`时间：${local.hour}:${local.minute}`);
    if (settings.promptIncludeWeekday) lines.push(`星期：${local.weekday}`);
  }

  if (
    settings.promptIncludeLunarDate ||
    settings.promptIncludeSolarTerm ||
    settings.promptIncludeHolidays
  ) {
    const china = localParts(now, 'Asia/Shanghai');
    // Do not use Solar.fromDate: it reads the process-local timezone. Explicit
    // civil fields keep production hosts and preview requests deterministic.
    const solar = calendar.Solar.fromYmdHms(
      Number(china.year),
      Number(china.month),
      Number(china.day),
      Number(china.hour),
      Number(china.minute),
      Number(china.second),
    );
    const lunar = solar.getLunar();
    const calendarBasis = settings.promptIncludeDate
      ? `以 Asia/Shanghai（北京时间）的 ${solar.toYmd()} 为准`
      : '采用 Asia/Shanghai（北京时间）口径';
    lines.push(`中国历法参考：${calendarBasis}；不代表法定假期或调休安排。`);
    const todayTerm =
      settings.promptIncludeSolarTerm || settings.promptIncludeHolidays
        ? lunar.getCurrentJieQi()
        : null;
    if (settings.promptIncludeLunarDate)
      lines.push(
        `农历：${lunar.getYearInChinese()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
      );
    if (settings.promptIncludeSolarTerm) {
      // wholeDay=false is essential: a term does not begin at midnight on its
      // calendar date, but at its calculated astronomical transition time.
      const previous = lunar.getPrevJieQi(false);
      lines.push(`当前节气：${previous?.getName() ?? '暂无可用计算结果'}`);
      if (todayTerm) {
        const transition = todayTerm.getSolar().toYmdHms();
        const state = transition <= solar.toYmdHms() ? '已交节' : '尚未交节';
        lines.push(
          `当日交节：${todayTerm.getName()} ${transition.slice(11, 16)}（北京时间，${state}）`,
        );
      } else lines.push('当日交节：无');
    }
    if (settings.promptIncludeHolidays) {
      // Qingming follows its solar-term date and is absent from the library's
      // two main festival lists. It is a festival, not an inferred day off.
      const holidays = [
        ...new Set([
          ...solar.getFestivals(),
          ...lunar.getFestivals(),
          ...(todayTerm?.getName() === '清明' ? ['清明节'] : []),
        ]),
      ];
      lines.push(`节日：${holidays.length ? holidays.join('、') : '无'}`);
    }
  }
  return lines.join('\n');
}
