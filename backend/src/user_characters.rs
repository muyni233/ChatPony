use rusqlite::OptionalExtension;
use serde::Deserialize;

use crate::avatars::{delete_avatar_by_url, save_avatar_file};
use crate::config::Config;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mappers::row_to_character;
use crate::models::{Character, ModelOption, SlotsInfo, User, UserCharacters, new_id, now_iso};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCharacterInput {
    pub name: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub personality: String,
    #[serde(default)]
    pub greeting: String,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCharacterPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub tags: Option<Vec<String>>,
    pub personality: Option<String>,
    pub greeting: Option<String>,
    pub provider_id: Option<Option<String>>,
    pub active: Option<bool>,
}

pub fn normalize_hex_color(raw: Option<&str>) -> AppResult<String> {
    let val = raw.unwrap_or("#315B52").trim();
    if val.is_empty() {
        return Ok("#315B52".to_string());
    }
    let valid = val.len() == 7
        && val.starts_with('#')
        && val[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::validation("主题色格式无效，请使用 #RRGGBB 格式。"));
    }
    Ok(val.to_ascii_uppercase())
}

pub fn normalize_tags(tags: &[String]) -> AppResult<Vec<String>> {
    if tags.len() > 10 {
        return Err(AppError::validation("标签数量不能超过 10 个。"));
    }
    let mut out = Vec::new();
    for raw in tags {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > 24 {
            return Err(AppError::validation("单个标签不能超过 24 个字符。"));
        }
        if !out.iter().any(|x: &String| x == t) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}

pub fn validate_slug_or_generate(
    conn: &rusqlite::Connection,
    requested: Option<&str>,
    name: &str,
) -> AppResult<String> {
    if let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        let low = raw.to_ascii_lowercase();
        let valid = !low.is_empty()
            && low.len() <= 64
            && low
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
        if !valid {
            return Err(AppError::validation(
                "角色标识（Slug）仅支持小写字母、数字、连字符和下划线。",
            ));
        }
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM characters WHERE slug=? COLLATE NOCASE",
                rusqlite::params![low],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Err(AppError::conflict("SLUG_EXISTS", "该角色标识已被占用。"));
        }
        return Ok(low);
    }

    let base: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(28)
        .collect();
    let prefix = if base.is_empty() { "oc" } else { base.as_str() };
    let suffix = &new_id().replace('-', "")[..8];
    Ok(format!("{prefix}-{suffix}"))
}

fn verify_language_model_option(
    conn: &rusqlite::Connection,
    provider_id: Option<&str>,
) -> AppResult<Option<String>> {
    let Some(pid) = provider_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let ok: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM providers p
             JOIN suppliers s ON s.id = p.supplier_id
             WHERE p.id=? AND p.deleted_at IS NULL AND p.active=1 AND p.kind='language'
               AND s.deleted_at IS NULL AND s.active=1",
            rusqlite::params![pid],
            |r| r.get(0),
        )
        .optional()?;
    if ok.is_none() {
        return Err(AppError::validation("指定的语言模型不可用或已停用。"));
    }
    Ok(Some(pid.to_string()))
}

pub fn list_user_characters(db: &Db, user: &User) -> AppResult<UserCharacters> {
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters
             WHERE owner_id=? AND deleted_at IS NULL
             ORDER BY created_at DESC",
        )?;
        let items = stmt
            .query_map(rusqlite::params![user.id], |r| row_to_character(r, true))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let limit = user.character_slots.clamp(0, 100);
        let used = items.len() as i64;
        let remaining = (limit - used).max(0);

        let mut mstmt = conn.prepare(
            "SELECT p.id, p.name
             FROM providers p
             JOIN suppliers s ON s.id = p.supplier_id
             WHERE p.deleted_at IS NULL AND p.active=1 AND p.kind='language'
               AND s.deleted_at IS NULL AND s.active=1
             ORDER BY p.created_at ASC",
        )?;
        let models = mstmt
            .query_map([], |r| {
                Ok(ModelOption {
                    id: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(UserCharacters {
            items,
            slots: SlotsInfo {
                used,
                limit,
                remaining,
            },
            models,
        })
    })
}

pub fn create_user_character(
    db: &Db,
    user: &User,
    input: UserCharacterInput,
) -> AppResult<Character> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(AppError::validation("角色名称长度需在 1 至 60 个字符之间。"));
    }
    let personality = input.personality.trim().to_string();
    if personality.is_empty() || personality.chars().count() > 8000 {
        return Err(AppError::validation("角色设定长度需在 1 至 8000 个字符之间。"));
    }
    let description = input.description.trim().chars().take(500).collect::<String>();
    let greeting = input.greeting.trim().chars().take(2000).collect::<String>();
    let color = normalize_hex_color(input.color.as_deref())?;
    let tags = normalize_tags(&input.tags)?;
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    db.write(|tx| {
        let slots: i64 = tx.query_row(
            "SELECT character_slots FROM users WHERE id=?",
            rusqlite::params![user.id],
            |r| r.get(0),
        )?;
        let used: i64 = tx.query_row(
            "SELECT COUNT(*) FROM characters WHERE owner_id=? AND deleted_at IS NULL",
            rusqlite::params![user.id],
            |r| r.get(0),
        )?;
        if used >= slots {
            return Err(AppError::forbidden(
                "CHARACTER_SLOT_LIMIT",
                "已达到个人私有角色栏位上限，请先删除不需要的角色或联系管理员扩容。",
            ));
        }

        let slug = validate_slug_or_generate(tx, input.slug.as_deref(), &name)?;
        let provider_id = verify_language_model_option(tx, input.provider_id.as_deref())?;
        let id = new_id();
        let now = now_iso();
        tx.execute(
            "INSERT INTO characters(id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at)
             VALUES(?,?,?,?,?,'',?,?,?,?,?,?,?)",
            rusqlite::params![
                id,
                user.id,
                name,
                slug,
                description,
                color,
                tags_json,
                personality,
                greeting,
                provider_id,
                if input.active { 1 } else { 0 },
                now
            ],
        )?;
        tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )
        .map_err(Into::into)
    })
}

pub fn update_user_character(
    db: &Db,
    user: &User,
    id: &str,
    patch: UserCharacterPatch,
) -> AppResult<Character> {
    db.write(|tx| {
        let existing: Option<Character> = tx
            .query_row(
                "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
                 FROM characters WHERE id=? AND owner_id=? AND deleted_at IS NULL",
                rusqlite::params![id, user.id],
                |r| row_to_character(r, true),
            )
            .optional()?;
        let Some(cur) = existing else {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "私有角色不存在。"));
        };

        let name = match patch.name {
            Some(n) => {
                let t = n.trim().to_string();
                if t.is_empty() || t.chars().count() > 60 {
                    return Err(AppError::validation("角色名称长度需在 1 至 60 个字符之间。"));
                }
                t
            }
            None => cur.name,
        };
        let description = patch
            .description
            .map(|d| d.trim().chars().take(500).collect())
            .unwrap_or(cur.description);
        let color = match patch.color {
            Some(c) => normalize_hex_color(Some(&c))?,
            None => cur.color,
        };
        let tags = match patch.tags {
            Some(t) => normalize_tags(&t)?,
            None => cur.tags,
        };
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
        let personality = match patch.personality {
            Some(p) => {
                let t = p.trim().to_string();
                if t.is_empty() || t.chars().count() > 8000 {
                    return Err(AppError::validation("角色设定长度需在 1 至 8000 个字符之间。"));
                }
                t
            }
            None => cur.personality.unwrap_or_default(),
        };
        let greeting = patch
            .greeting
            .map(|g| g.trim().chars().take(2000).collect())
            .unwrap_or(cur.greeting);
        let provider_id = match patch.provider_id {
            Some(opt) => verify_language_model_option(tx, opt.as_deref())?,
            None => cur.provider_id,
        };
        let active = patch.active.unwrap_or(cur.active);

        tx.execute(
            "UPDATE characters
             SET name=?, description=?, color=?, tags=?, personality=?, greeting=?, provider_id=?, active=?
             WHERE id=? AND owner_id=?",
            rusqlite::params![
                name,
                description,
                color,
                tags_json,
                personality,
                greeting,
                provider_id,
                if active { 1 } else { 0 },
                id,
                user.id
            ],
        )?;
        tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )
        .map_err(Into::into)
    })
}

pub fn delete_user_character(db: &Db, config: &Config, user: &User, id: &str) -> AppResult<()> {
    let old_avatar = db.write(|tx| {
        let avatar: Option<String> = tx
            .query_row(
                "SELECT avatar FROM characters WHERE id=? AND owner_id=? AND deleted_at IS NULL",
                rusqlite::params![id, user.id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(av) = avatar else {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "私有角色不存在。"));
        };
        let now = now_iso();
        tx.execute(
            "UPDATE characters SET deleted_at=?, active=0, avatar='' WHERE id=? AND owner_id=?",
            rusqlite::params![now, id, user.id],
        )?;
        Ok(av)
    })?;
    if !old_avatar.is_empty() {
        delete_avatar_by_url(config, &old_avatar);
    }
    Ok(())
}

pub fn set_user_character_avatar(
    db: &Db,
    config: &Config,
    user: &User,
    id: &str,
    image_bytes: &[u8],
) -> AppResult<Character> {
    // Check ownership first
    let prev_avatar: String = db.read(|conn| {
        conn.query_row(
            "SELECT avatar FROM characters WHERE id=? AND owner_id=? AND deleted_at IS NULL",
            rusqlite::params![id, user.id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("CHARACTER_NOT_FOUND", "私有角色不存在。"))
    })?;

    let new_url = save_avatar_file(config, image_bytes)?;
    let res = db.write(|tx| {
        let updated = tx.execute(
            "UPDATE characters SET avatar=? WHERE id=? AND owner_id=? AND deleted_at IS NULL",
            rusqlite::params![new_url, id, user.id],
        )?;
        if updated == 0 {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "私有角色不存在。"));
        }
        tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )
        .map_err(Into::into)
    });

    match res {
        Ok(ch) => {
            if !prev_avatar.is_empty() && prev_avatar != new_url {
                delete_avatar_by_url(config, &prev_avatar);
            }
            Ok(ch)
        }
        Err(err) => {
            delete_avatar_by_url(config, &new_url);
            Err(err)
        }
    }
}

pub fn clear_user_character_avatar(
    db: &Db,
    config: &Config,
    user: &User,
    id: &str,
) -> AppResult<Character> {
    let (ch, old_avatar) = db.write(|tx| {
        let prev: Option<String> = tx
            .query_row(
                "SELECT avatar FROM characters WHERE id=? AND owner_id=? AND deleted_at IS NULL",
                rusqlite::params![id, user.id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(old) = prev else {
            return Err(AppError::not_found("CHARACTER_NOT_FOUND", "私有角色不存在。"));
        };
        tx.execute(
            "UPDATE characters SET avatar='' WHERE id=? AND owner_id=?",
            rusqlite::params![id, user.id],
        )?;
        let ch = tx.query_row(
            "SELECT id,owner_id,name,slug,description,avatar,color,tags,personality,greeting,provider_id,active,created_at
             FROM characters WHERE id=?",
            rusqlite::params![id],
            |r| row_to_character(r, true),
        )?;
        Ok((ch, old))
    })?;
    if !old_avatar.is_empty() {
        delete_avatar_by_url(config, &old_avatar);
    }
    Ok(ch)
}
