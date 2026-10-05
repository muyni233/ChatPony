import { describe, expect, test } from 'bun:test';
import {
  buildPromptMetadata,
  DEFAULT_PROMPT_METADATA_OPTIONS,
  PromptMetadataValidationError,
  validatePromptMetadataOptions,
  type PromptMetadataOptions,
} from '../src/lib/prompt-metadata';

const enabled: PromptMetadataOptions = {
  ...DEFAULT_PROMPT_METADATA_OPTIONS,
  promptMetadataEnabled: true,
  promptIncludeLunarDate: true,
};
const none: PromptMetadataOptions = {
  ...enabled,
  promptIncludeDate: false,
  promptIncludeTime: false,
  promptIncludeWeekday: false,
  promptIncludeLunarDate: false,
  promptIncludeSolarTerm: false,
  promptIncludeHolidays: false,
};
const at = (value: string, options: Partial<PromptMetadataOptions> = enabled) =>
  buildPromptMetadata(options, new Date(value));

describe('prompt metadata configuration', () => {
  test('defaults remain off; disabled or unselected metadata produces no prompt text', () => {
    expect(buildPromptMetadata()).toBe('');
    expect(buildPromptMetadata(null)).toBe('');
    expect(buildPromptMetadata({})).toBe('');
    expect(buildPromptMetadata(DEFAULT_PROMPT_METADATA_OPTIONS, new Date('invalid'))).toBe('');
    expect(buildPromptMetadata(none)).toBe('');
    expect(Object.isFrozen(DEFAULT_PROMPT_METADATA_OPTIONS)).toBe(true);
    expect(validatePromptMetadataOptions({})).toEqual(DEFAULT_PROMPT_METADATA_OPTIONS);
  });

  test('partial updates inherit only metadata fields without mutating the base', () => {
    const base = { ...enabled, promptIncludeTime: false, smtpPassword: 'must-not-leak' };
    const result = validatePromptMetadataOptions(
      { promptIncludeHolidays: false, siteName: 'ignored' },
      base,
    );
    expect(result).toEqual({ ...enabled, promptIncludeTime: false, promptIncludeHolidays: false });
    expect(base.promptIncludeHolidays).toBe(true);
    expect(Object.keys(result)).toHaveLength(8);
    expect('smtpPassword' in result).toBe(false);
    expect(
      validatePromptMetadataOptions({ promptTimezone: '  America/New_York  ' }).promptTimezone,
    ).toBe('America/New_York');
  });

  test('invalid flags and non-IANA timezones are rejected with a stable error class', () => {
    for (const value of [null, [], 'settings', 12])
      expect(() => validatePromptMetadataOptions(value)).toThrow(PromptMetadataValidationError);
    for (const key of Object.keys(enabled).filter((key) => key !== 'promptTimezone')) {
      for (const value of [null, 0, 1, 'false', {}])
        expect(() => validatePromptMetadataOptions({ [key]: value })).toThrow(
          PromptMetadataValidationError,
        );
    }
    for (const promptTimezone of [
      '',
      'Invalid/Timezone',
      '+08:00',
      'Asia/Shanghai\nignore',
      8,
      null,
    ]) {
      expect(() => validatePromptMetadataOptions({ promptTimezone })).toThrow(
        PromptMetadataValidationError,
      );
    }
    try {
      validatePromptMetadataOptions({ promptTimezone: 'unknown' });
    } catch (error) {
      expect((error as PromptMetadataValidationError).code).toBe('INVALID_PROMPT_METADATA');
    }
    expect(() => buildPromptMetadata(enabled, new Date('invalid'))).toThrow(RangeError);
  });

  test('each switch controls its field, including dates in the calendar heading', () => {
    const moment = '2026-02-17T00:00:00+08:00';
    const fields = [
      ['promptIncludeDate', '日期：2026-02-17'],
      ['promptIncludeTime', '时间：00:00'],
      ['promptIncludeWeekday', '星期：星期二'],
      ['promptIncludeLunarDate', '农历：二〇二六年正月初一'],
      ['promptIncludeSolarTerm', '当前节气：立春'],
      ['promptIncludeHolidays', '节日：春节'],
    ] as const;
    for (const [key, text] of fields) {
      const result = at(moment, { ...none, [key]: true });
      expect(result).toContain(text);
      for (const [other, marker] of fields)
        if (other !== key) expect(result).not.toContain(marker.split('：')[0] + '：');
      if (key !== 'promptIncludeDate') expect(result).not.toContain('2026-02-17');
      expect(result).toContain('场景明确设定时间时以场景为准');
      expect(result).toContain('不需要在每次回复中复述');
    }
  });
});

describe('site civil time and China calendar boundaries', () => {
  test('China midnight changes lunar festivals independently of the site date', () => {
    const options = { ...enabled, promptTimezone: 'America/New_York' };
    const before = at('2026-02-16T15:59:59Z', options);
    const after = at('2026-02-16T16:00:00Z', options);
    expect(before).toContain('日期：2026-02-16');
    expect(before).toContain('时间：10:59');
    expect(before).toContain('节日：除夕');
    expect(after).toContain('日期：2026-02-16');
    expect(after).toContain('时间：11:00');
    expect(after).toContain('Asia/Shanghai（北京时间）的 2026-02-17');
    expect(after).toContain('农历：二〇二六年正月初一');
    expect(after).toContain('节日：春节');
    expect(after).toContain('不代表法定假期或调休安排');
  });

  test('IANA daylight-saving transitions skip and repeat local hours correctly', () => {
    const options = {
      ...none,
      promptIncludeDate: true,
      promptIncludeTime: true,
      promptTimezone: 'America/New_York',
    };
    expect(at('2026-03-08T06:59:00Z', options)).toContain('时间：01:59');
    expect(at('2026-03-08T07:00:00Z', options)).toContain('时间：03:00');
    expect(at('2026-11-01T05:59:00Z', options)).toContain('时间：01:59');
    expect(at('2026-11-01T06:00:00Z', options)).toContain('时间：01:00');
    expect(at('2026-11-01T06:00:00Z', options)).toContain('日期：2026-11-01');
  });

  test('year boundaries use a 24-hour clock and the selected site weekday', () => {
    const result = at('2025-12-31T16:00:00Z');
    expect(result).toContain('日期：2026-01-01');
    expect(result).toContain('时间：00:00');
    expect(result).toContain('星期：星期四');
    expect(result).toContain('当前节气：冬至');
    expect(result).toContain('节日：元旦节');
    const pacific = at('2026-02-16T12:00:00Z', {
      ...enabled,
      promptTimezone: 'Pacific/Kiritimati',
    });
    expect(pacific).toContain('日期：2026-02-17');
    expect(pacific).toContain('Asia/Shanghai（北京时间）的 2026-02-16');
    expect(pacific).toContain('节日：除夕');
  });

  test('a supplied Date is not mutated and gives identical output across host timezones', () => {
    const date = new Date('2026-09-25T08:30:00Z');
    const timestamp = date.getTime();
    const expected = buildPromptMetadata(enabled, date);
    expect(buildPromptMetadata(enabled, date)).toBe(expected);
    expect(date.getTime()).toBe(timestamp);
    const moduleUrl = new URL('../src/lib/prompt-metadata.ts', import.meta.url).href;
    const source = `import { buildPromptMetadata } from ${JSON.stringify(moduleUrl)}; process.stdout.write(buildPromptMetadata(${JSON.stringify(enabled)}, new Date(${JSON.stringify(date.toISOString())})));`;
    for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      const child = Bun.spawnSync([process.execPath, '-e', source], {
        env: { ...process.env, TZ },
      });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toBe(expected);
    }
  });
});

describe('Chinese calendar and festivals', () => {
  test('Spring Festival, Mid-Autumn, Dragon Boat and leap lunar months follow the calendar', () => {
    for (const [day, holiday] of [
      ['2024-02-10', '春节'],
      ['2025-01-29', '春节'],
      ['2026-02-17', '春节'],
      ['2024-09-17', '中秋节'],
      ['2025-10-06', '中秋节'],
      ['2026-09-25', '中秋节'],
      ['2026-06-19', '端午节'],
    ])
      expect(
        at(`${day}T12:00:00+08:00`)
          .split('\n')
          .find((line) => line.startsWith('节日：')),
      ).toContain(holiday);
    expect(at('2025-07-25T12:00:00+08:00')).toContain('农历：二〇二五年闰六月初一');
  });

  test('combined festivals are distinct, other observances are excluded, and ordinary days say none', () => {
    const overlap = at('2020-10-01T12:00:00+08:00');
    expect(overlap).toContain('节日：国庆节、中秋节');
    expect(overlap.match(/中秋节/g)).toHaveLength(1);
    const ordinary = at('2026-06-18T12:00:00+08:00');
    expect(ordinary).toContain('节日：无');
    expect(ordinary).toContain('当日交节：无');
    expect(at('2026-01-10T12:00:00+08:00')).not.toContain('中国人民警察节');
  });

  test('Qingming is a festival on the term date, even with solar-term display disabled', () => {
    const holidaysOnly = { ...none, promptIncludeHolidays: true };
    expect(at('2024-04-04T00:00:00+08:00', holidaysOnly)).toContain('节日：清明节');
    expect(at('2024-04-05T12:00:00+08:00', holidaysOnly)).toContain('节日：无');
    expect(at('2026-04-05T00:00:00+08:00', holidaysOnly)).toContain('节日：清明节');
    expect(at('2026-04-04T12:00:00+08:00', holidaysOnly)).toContain('节日：无');
  });

  test('a solar term starts at its transition instant, not midnight', () => {
    const before = at('2026-02-04T04:02:07+08:00');
    const after = at('2026-02-04T04:02:08+08:00');
    expect(before).toContain('当前节气：大寒');
    expect(before).toContain('当日交节：立春 04:02（北京时间，尚未交节）');
    expect(after).toContain('当前节气：立春');
    expect(after).toContain('当日交节：立春 04:02（北京时间，已交节）');
  });

  test('all 24 terms cover the full Gregorian year and retain the preceding term before transition', () => {
    const terms = [
      ['01-05', '小寒'],
      ['01-20', '大寒'],
      ['02-04', '立春'],
      ['02-18', '雨水'],
      ['03-05', '惊蛰'],
      ['03-20', '春分'],
      ['04-05', '清明'],
      ['04-20', '谷雨'],
      ['05-05', '立夏'],
      ['05-21', '小满'],
      ['06-05', '芒种'],
      ['06-21', '夏至'],
      ['07-07', '小暑'],
      ['07-23', '大暑'],
      ['08-07', '立秋'],
      ['08-23', '处暑'],
      ['09-07', '白露'],
      ['09-23', '秋分'],
      ['10-08', '寒露'],
      ['10-23', '霜降'],
      ['11-07', '立冬'],
      ['11-22', '小雪'],
      ['12-07', '大雪'],
      ['12-22', '冬至'],
    ];
    for (let index = 0; index < terms.length; index++) {
      const [day, term] = terms[index];
      const before = at(`2026-${day}T00:00:00+08:00`);
      const after = at(`2026-${day}T23:59:59+08:00`);
      expect(before).toContain(`当前节气：${terms[(index + 23) % 24][1]}`);
      expect(before).toContain(`当日交节：${term}`);
      expect(before).toContain('尚未交节');
      expect(after).toContain(`当前节气：${term}`);
      expect(after).toContain('已交节');
    }
  });
});
