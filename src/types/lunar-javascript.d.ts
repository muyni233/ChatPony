declare module 'lunar-javascript' {
  interface SolarDate {
    getLunar(): LunarDate;
    getFestivals(): string[];
    toYmd(): string;
    toYmdHms(): string;
  }

  interface SolarTerm {
    getName(): string;
    getSolar(): SolarDate;
  }

  interface LunarDate {
    getYearInChinese(): string;
    getMonthInChinese(): string;
    getDayInChinese(): string;
    getFestivals(): string[];
    getPrevJieQi(wholeDay?: boolean): SolarTerm | null;
    getCurrentJieQi(): SolarTerm | null;
  }

  const calendar: {
    Solar: {
      fromYmdHms(
        year: number,
        month: number,
        day: number,
        hour: number,
        minute: number,
        second: number,
      ): SolarDate;
    };
  };

  export default calendar;
}
