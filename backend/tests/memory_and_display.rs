use std::io::Cursor;
use std::path::PathBuf;

use chrono::{Duration, Utc};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use tempfile::TempDir;

use chatpony_backend::ai::memory::{
    StructuredMemoryItem, hybrid_recall, maintain_memories, parse_structured_memories,
    query_terms, similarity, upsert_auto_memory,
};
use chatpony_backend::attachments::process_attachment_bytes;
use chatpony_backend::avatars::{can_read_avatar, process_avatar_bytes};
use chatpony_backend::config::Config;
use chatpony_backend::crypto::CryptoService;
use chatpony_backend::db::Db;
use chatpony_backend::display::{message_bubbles, strip_display_symbols};
use chatpony_backend::models::{MemoryKind, User, iso_from_utc, new_id, now_iso};
use chatpony_backend::repository::read_settings;

fn temp_config(dir: &TempDir) -> Config {
    Config {
        database_path: dir.path().join("mem.db").to_string_lossy().to_string(),
        encryption_key: None,
        trust_proxy: false,
        host: "127.0.0.1".to_string(),
        port: 0,
        static_dir: PathBuf::from("nonexistent"),
    }
}

fn make_png(w: u32, h: u32) -> Vec<u8> {
    let mut img = RgbaImage::new(w, h);
    for px in img.pixels_mut() {
        *px = Rgba([49, 91, 82, 255]);
    }
    let dyn_img = DynamicImage::ImageRgba8(img);
    let mut buf = Cursor::new(Vec::new());
    dyn_img.write_to(&mut buf, ImageFormat::Png).unwrap();
    buf.into_inner()
}

#[test]
fn display_bubbles_and_hidden_symbols_behave_cleanly() {
    let cleaned = strip_display_symbols("你好~~ 世界 <thinking>secret</thinking>!", &["~~".into()]);
    assert_eq!(cleaned, "你好 世界 <thinking>secret</thinking>!");
    let bubbles = message_bubbles("第一句|||第二句|||\n\n第三句", "|||", &[], true);
    assert_eq!(bubbles, vec!["第一句", "第二句", "第三句"]);
}

#[test]
fn images_normalize_and_private_avatar_access_is_isolated() {
    let png_avatar = make_png(400, 300);
    let webp_av = process_avatar_bytes(&png_avatar).unwrap();
    assert_eq!(&webp_av[0..4], b"RIFF");
    assert_eq!(&webp_av[8..12], b"WEBP");

    let png_att = make_png(2400, 1200);
    let (webp_att, w, h) = process_attachment_bytes(&png_att).unwrap();
    assert_eq!(&webp_att[0..4], b"RIFF");
    assert_eq!(w, 1568);
    assert_eq!(h, 784);

    // Reject non-image spoofed payload
    assert!(process_avatar_bytes(b"<script>alert(1)</script>").is_err());

    let dir = TempDir::new().unwrap();
    let db = Db::open(&temp_config(&dir)).unwrap();
    let owner = User {
        id: "u1".into(),
        email: "u1@example.com".into(),
        name: "Owner".into(),
        role: "user".into(),
        disabled: false,
        timezone: "Asia/Shanghai".into(),
        created_at: now_iso(),
        email_verified_at: None,
        avatar: "".into(),
        persona: None,
        limit5h: 50,
        limit7d: 500,
        character_slots: 3,
    };
    let stranger = User {
        id: "u2".into(),
        ..owner.clone()
    };

    db.write(|tx| {
        tx.execute(
            "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('u1','u1@ex.com','U1','h','user',?)",
            rusqlite::params![now_iso()],
        )?;
        tx.execute(
            "INSERT INTO characters(id,owner_id,name,slug,avatar,personality,active,created_at)
             VALUES('ch_priv','u1','SecretOC','secret-oc','/api/avatars/secret.webp','p',1,?)",
            rusqlite::params![now_iso()],
        )?;
        Ok(())
    })
    .unwrap();

    db.read(|conn| {
        let (allow_guest, is_priv) = can_read_avatar(conn, "/api/avatars/secret.webp", None)?;
        assert!(!allow_guest && is_priv);
        let (allow_stranger, _) =
            can_read_avatar(conn, "/api/avatars/secret.webp", Some(&stranger))?;
        assert!(!allow_stranger);
        let (allow_owner, _) = can_read_avatar(conn, "/api/avatars/secret.webp", Some(&owner))?;
        assert!(allow_owner);
        Ok(())
    })
    .unwrap();
}

#[tokio::test]
async fn living_memory_lifecycle_fts_mmr_dedup_and_decay() {
    let dir = TempDir::new().unwrap();
    let cfg = temp_config(&dir);
    let db = Db::open(&cfg).unwrap();
    let crypto = CryptoService::new(&cfg);
    let http = reqwest::Client::new();
    let uid = new_id();
    let cid = new_id();

    db.write(|tx| {
        tx.execute(
            "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,'m@ex.com','Mem','h','user',?)",
            rusqlite::params![uid, now_iso()],
        )?;
        tx.execute(
            "INSERT INTO characters(id,name,slug,personality,active,created_at) VALUES(?,'Twilight','twi','p',1,?)",
            rusqlite::params![cid, now_iso()],
        )?;
        Ok(())
    })
    .unwrap();

    // Parse structured memory JSON
    let raw = r#"```json
    [{"kind":"preference","content":"用户喜欢喝热燕麦拿铁并且偏好少冰少糖","importance":0.85,"tags":["饮品"]}]
    ```"#;
    let parsed = parse_structured_memories(raw);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].kind, MemoryKind::Preference);

    // Upsert & dedup near duplicate >= 0.82
    let id1 = upsert_auto_memory(&db, &uid, &cid, &parsed[0], None).unwrap();
    let dup = StructuredMemoryItem {
        kind: MemoryKind::Preference,
        content: "用户喜欢喝热燕麦拿铁并且偏好少冰少糖!".into(),
        importance: 0.9,
        tags: vec!["咖啡".into()],
        ttl_days: None,
    };
    assert!(similarity(&parsed[0].content, &dup.content) >= 0.82);
    let id2 = upsert_auto_memory(&db, &uid, &cid, &dup, None).unwrap();
    assert_eq!(id1, id2);

    // Distinct memory
    let trip = StructuredMemoryItem {
        kind: MemoryKind::Plan,
        content: "周末和暮光闪闪约好去小马谷图书馆看魔法书".into(),
        importance: 0.8,
        tags: vec!["约定".into()],
        ttl_days: None,
    };
    let id3 = upsert_auto_memory(&db, &uid, &cid, &trip, None).unwrap();
    assert_ne!(id1, id3);

    // FTS trigram + MMR recall
    let (all_t, tri) = query_terms("图书馆魔法书");
    assert!(!all_t.is_empty());
    assert!(!tri.is_empty());

    let settings = db.read(read_settings).unwrap();
    let recalled = hybrid_recall(
        &db,
        &crypto,
        &http,
        &uid,
        &cid,
        "图书馆 魔法书",
        &settings,
        true,
    )
    .await
    .unwrap();
    assert!(!recalled.is_empty());
    assert_eq!(recalled[0].id, id3);
    assert!(recalled[0].routes.iter().any(|r| r == "fts" || r == "keyword"));

    // Decay old untouched low-importance auto memory after > 14 days
    let old_id = new_id();
    let old_ts = iso_from_utc(Utc::now() - Duration::days(60));
    db.write(|tx| {
        tx.execute(
            "INSERT INTO memories(id,user_id,character_id,content,source,kind,importance,status,access_count,tags,created_at,updated_at)
             VALUES(?,?,?,'很久以前的琐碎天气记录','auto','note',0.26,'active',0,'[]',?,?)",
            rusqlite::params![old_id, uid, cid, old_ts, old_ts],
        )?;
        Ok(())
    })
    .unwrap();

    let archived = maintain_memories(&db, &uid, &cid, &settings).unwrap();
    assert!(archived >= 1);
    let st: String = db
        .read(|conn| {
            conn.query_row(
                "SELECT status FROM memories WHERE id=?",
                rusqlite::params![old_id],
                |r| r.get(0),
            )
            .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(st, "archived");
}
