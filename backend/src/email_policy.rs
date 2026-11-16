use std::collections::HashSet;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

pub struct RegistrationPolicy {
    pub registration_open: bool,
    pub require_email_verification: bool,
    pub email_domain_mode: String,
    pub email_domains: Vec<String>,
}

pub fn normalize_email_domain(value: &str, wildcard: bool) -> AppResult<String> {
    let input = value.trim().to_lowercase();
    if input.chars().any(|c| {
        c.is_whitespace()
            || matches!(c, '/' | '@' | ':' | '#' | '?' | '[' | ']' | '\\')
            || (c as u32) <= 0x1f
            || c == '\x7f'
    }) {
        return Err(AppError::bad_request(
            "INVALID_EMAIL_DOMAIN",
            "请只填写邮箱域名，不包含协议、路径或端口。",
        ));
    }

    let (prefix, raw_domain) = if wildcard && input.starts_with("*.") {
        ("*.", &input[2..])
    } else {
        ("", input.as_str())
    };

    let ascii = idna::domain_to_ascii(raw_domain)
        .map_err(|_| {
            AppError::bad_request(
                "INVALID_EMAIL_DOMAIN",
                "邮箱域名无效，请使用 example.com 或 *.example.com 格式。",
            )
        })?
        .to_lowercase();

    let valid_labels = !ascii.is_empty()
        && ascii.len() <= 253
        && ascii.contains('.')
        && ascii.split('.').all(|label| {
            let bytes = label.as_bytes();
            !bytes.is_empty()
                && bytes.len() <= 63
                && bytes[0].is_ascii_alphanumeric()
                && bytes[bytes.len() - 1].is_ascii_alphanumeric()
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
        });

    if !valid_labels {
        return Err(AppError::bad_request(
            "INVALID_EMAIL_DOMAIN",
            "邮箱域名无效，请使用 example.com 或 *.example.com 格式。",
        ));
    }
    Ok(format!("{prefix}{ascii}"))
}

pub fn normalize_email(value: &str) -> AppResult<String> {
    let input = value.trim();
    let parts: Vec<&str> = input.split('@').collect();
    if parts.len() != 2
        || parts[0].is_empty()
        || parts[0].len() > 64
        || parts[0].chars().any(|c| {
            c.is_whitespace()
                || matches!(c, '<' | '>' | '(' | ')' | ',' | ';' | ':' | '[' | ']' | '"' | '\\')
                || (c as u32) <= 0x1f
                || c == '\x7f'
        })
    {
        return Err(AppError::validation("请输入有效的电子邮箱。"));
    }
    let domain = normalize_email_domain(parts[1], false)
        .map_err(|_| AppError::validation("请输入有效的电子邮箱。"))?;
    let email = format!("{}@{}", parts[0].to_lowercase(), domain);
    if email.len() > 254 {
        return Err(AppError::validation("请输入有效的电子邮箱。"));
    }
    Ok(email)
}

pub fn normalize_email_domains(input: &[String]) -> AppResult<Vec<String>> {
    if input.len() > 100 || input.iter().any(|s| s.len() > 255) {
        return Err(AppError::bad_request(
            "INVALID_EMAIL_DOMAIN",
            "域名规则最多 100 项，每项最多 255 个字符。",
        ));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(input.len());
    for item in input {
        let normalized = normalize_email_domain(item, true)?;
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    Ok(out)
}

pub fn email_domain_allowed(email: &str, mode: &str, domains: &[String]) -> bool {
    if mode == "any" {
        return true;
    }
    let Some(at) = email.rfind('@') else {
        return false;
    };
    let domain = &email[at + 1..];
    let matches = domains.iter().any(|rule| {
        if let Some(suffix_root) = rule.strip_prefix("*.") {
            let dot_suffix = &rule[1..]; // ".example.com"
            domain.ends_with(dot_suffix) && domain != suffix_root
        } else {
            domain == rule
        }
    });
    if mode == "allowlist" {
        matches
    } else {
        !matches
    }
}

pub fn get_registration_policy(conn: &Connection) -> AppResult<RegistrationPolicy> {
    let mut stmt = conn.prepare(
        "SELECT key,value FROM settings WHERE key IN ('registrationOpen','requireEmailVerification','emailDomainMode','emailDomains')",
    )?;
    let mut rows = stmt.query([])?;
    let mut registration_open = true;
    let mut require_email_verification = false;
    let mut email_domain_mode = "any".to_string();
    let mut email_domains = Vec::new();
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let val_raw: String = row.get(1)?;
        let val: serde_json::Value = serde_json::from_str(&val_raw).unwrap_or(serde_json::Value::Null);
        match key.as_str() {
            "registrationOpen" => {
                registration_open = val.as_bool().unwrap_or(true);
            }
            "requireEmailVerification" => {
                require_email_verification = val.as_bool().unwrap_or(false);
            }
            "emailDomainMode" => {
                if let Some(s) = val.as_str() {
                    if s == "allowlist" || s == "blocklist" {
                        email_domain_mode = s.to_string();
                    }
                }
            }
            "emailDomains" => {
                if let Some(arr) = val.as_array() {
                    email_domains = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(ToString::to_string))
                        .collect();
                }
            }
            _ => {}
        }
    }
    Ok(RegistrationPolicy {
        registration_open,
        require_email_verification,
        email_domain_mode,
        email_domains,
    })
}

pub fn assert_registration_allowed(
    conn: &Connection,
    email: &str,
) -> AppResult<RegistrationPolicy> {
    let policy = get_registration_policy(conn)?;
    if !policy.registration_open {
        return Err(AppError::forbidden("REGISTRATION_CLOSED", "平台暂未开放注册。"));
    }
    if !email_domain_allowed(email, &policy.email_domain_mode, &policy.email_domains) {
        return Err(AppError::forbidden(
            "EMAIL_DOMAIN_RESTRICTED",
            "该邮箱域名不符合平台的注册规则，请使用其他邮箱。",
        ));
    }
    Ok(policy)
}
