declare module 'lunar-javascript' {
  interface LunarDate {
    toString(): string;
    getJieQi(): string;
    getPrevJieQi(wholeDay?: boolean): { getName(): string };
    getFestivals(): string[];
  }
  interface SolarDate {
    getLunar(): LunarDate;
    getFestivals(): string[];
  }
  export const Solar: {
    fromYmdHms(
      year: number,
      month: number,
      day: number,
      hour: number,
      minute: number,
      second: number,
    ): SolarDate;
  };
}
