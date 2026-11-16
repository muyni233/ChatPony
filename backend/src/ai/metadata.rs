use chrono::{Datelike, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use tyme4rs::tyme::Culture;
use tyme4rs::tyme::solar::{SolarDay, SolarTime};

use crate::models::PlatformSettings;

fn weekday_zh(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "星期一",
        Weekday::Tue => "星期二",
        Weekday::Wed => "星期三",
        Weekday::Thu => "星期四",
        Weekday::Fri => "星期五",
        Weekday::Sat => "星期六",
        Weekday::Sun => "星期日",
    }
}

pub fn build_metadata_block(settings: &PlatformSettings, user_timezone: &str) -> String {
    if !settings.metadata_enabled {
        return String::new();
    }

    let tz_name = if !settings.metadata_timezone.trim().is_empty() {
        settings.metadata_timezone.trim()
    } else if !user_timezone.trim().is_empty() {
        user_timezone.trim()
    } else {
        "Asia/Shanghai"
    };
    let tz: Tz = tz_name.parse().unwrap_or(chrono_tz::Asia::Shanghai);
    let effective_tz = tz.name();
    let now = Utc::now().with_timezone(&tz);

    let year = now.year() as isize;
    let month = now.month() as usize;
    let day = now.day() as usize;
    let hour = now.hour() as usize;
    let minute = now.minute() as usize;
    let second = now.second() as usize;

    let solar_day = SolarDay::from_ymd(year, month, day);
    let lunar = solar_day.get_lunar_day();
    let term_day = solar_day.get_term_day();
    let term_season = SolarTime::from_ymd_hms(year, month, day, hour, minute, second)
        .get_term()
        .get_name();

    let mut lines: Vec<String> = Vec::new();
    let has = |field: &str| settings.metadata_fields.iter().any(|f| f == field);

    if has("date") {
        lines.push(format!("当前日期：{:04}-{:02}-{:02}", now.year(), now.month(), now.day()));
    }
    if has("time") {
        lines.push(format!("当前时间：{:02}:{:02}", now.hour(), now.minute()));
    }
    if has("weekday") {
        lines.push(format!("星期：{}", weekday_zh(now.weekday())));
    }
    if has("timezone") {
        lines.push(format!("时区：{effective_tz}"));
    }
    if has("lunarDate") {
        lines.push(format!("农历日期：{lunar}"));
    }
    if has("solarTermToday") && term_day.get_day_index() == 0 {
        lines.push(format!("今日节气：{}", term_day.get_solar_term().get_name()));
    }
    if has("solarTermSeason") {
        lines.push(format!("当前节气：{term_season}"));
    }
    if has("festivals") {
        let mut fests: Vec<String> = Vec::new();
        if let Some(sf) = solar_day.get_festival() {
            let name = sf.get_name();
            if !name.is_empty() {
                fests.push(name);
            }
        }
        if let Some(lf) = lunar.get_festival() {
            let name = lf.get_name();
            if !name.is_empty() && !fests.contains(&name) {
                fests.push(name);
            }
        }
        if !fests.is_empty() {
            lines.push(format!("今日节日：{}", fests.join("、")));
        }
    }

    let custom = settings.metadata_custom.trim();
    if !custom.is_empty() {
        lines.push(format!("补充环境说明：{custom}"));
    }

    if lines.is_empty() {
        String::new()
    } else {
        format!("当前现实时间与环境参考（仅作语境感知，不必刻意复述）：\n{}", lines.join("\n"))
    }
}
