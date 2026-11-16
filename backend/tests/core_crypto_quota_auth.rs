use std::path::PathBuf;
use std::sync::Arc;

use tempfile::TempDir;

use chatpony_backend::ai::group::{GroupQueue, find_mentions};
use chatpony_backend::ai::metadata::build_metadata_block;
use chatpony_backend::ai::persona::build_persona_block;
use chatpony_backend::auth::{hash_password, verify_password};
use chatpony_backend::config::Config;
use chatpony_backend::crypto::CryptoService;
use chatpony_backend::db::Db;
use chatpony_backend::email_policy::{
    email_domain_allowed, normalize_email, normalize_email_domain,
};
use chatpony_backend::models::{Character, UserPersona, new_id, now_iso};
use chatpony_backend::quota::{finish_call, get_quota, reserve_call, reset_quota};
use chatpony_backend::repository::read_settings;

fn temp_config(dir: &TempDir) -> Config {
    Config {
        database_path: dir.path().join("test.db").to_string_lossy().to_string(),
        encryption_key: None,
        trust_proxy: false,
        host: "127.0.0.1".to_string(),
        port: 0,
        static_dir: PathBuf::from("nonexistent"),
    }
}

#[test]
fn crypto_persists_key_and_roundtrips() {
    let dir = TempDir::new().unwrap();
    let cfg = temp_config(&dir);
    let c1 = CryptoService::new(&cfg);
    let cipher = c1.encrypt("sk-secret-value-123").unwrap();
    assert!(cipher.starts_with("v1:"));

    // Second instance loads same .encryption-key file
    let c2 = CryptoService::new(&cfg);
    assert_eq!(c2.decrypt(&cipher).unwrap(), "sk-secret-value-123");
    assert_eq!(c2.decrypt("").unwrap(), "");
    assert!(c2.decrypt("v1:bad:bad:bad").is_err());
}

#[test]
fn argon2id_parameters_match_bun_phc_format() {
    let hash = hash_password("PonySecret123!").unwrap();
    assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
    assert!(verify_password("PonySecret123!", &hash));
    assert!(!verify_password("WrongPassword", &hash));
}

#[tokio::test]
async fn quota_enforces_limit_under_concurrent_tasks() {
    let dir = TempDir::new().unwrap();
    let cfg = temp_config(&dir);
    let db = Db::open(&cfg).unwrap();
    let uid = new_id();
    db.write(|tx| {
        tx.execute(
            "INSERT INTO users(id,email,name,password_hash,role,limit_5h,limit_7d,created_at)
             VALUES(?,'q@example.com','Quota','h','user',3,10,?)",
            rusqlite::params![uid, now_iso()],
        )?;
        Ok(())
    })
    .unwrap();

    let mut handles = Vec::new();
    for _ in 0..8 {
        let d = db.clone();
        let u = uid.clone();
        handles.push(tokio::spawn(async move {
            reserve_call(&d, &u, None, None)
        }));
    }
    let mut reserved_ids = Vec::new();
    let mut rejected = 0;
    for h in handles {
        match h.await.unwrap() {
            Ok(id) => reserved_ids.push(id),
            Err(err) => {
                assert_eq!(err.code, "QUOTA_5H_EXCEEDED");
                rejected += 1;
            }
        }
    }
    assert_eq!(reserved_ids.len(), 3);
    assert_eq!(rejected, 5);

    // Failed calls still release pending lock cleanly; mark one failed and verify slot frees
    finish_call(&db, &reserved_ids[0], false);
    let extra = reserve_call(&db, &uid, None, None).unwrap();
    finish_call(&db, &extra, true);

    let snap = get_quota(&db, &uid).unwrap();
    assert_eq!(snap.five_hour.used, 3);
    assert_eq!(snap.five_hour.remaining, 0);

    // Admin reset restores window
    let after_reset = reset_quota(&db, &uid).unwrap();
    assert_eq!(after_reset.five_hour.used, 0);
    assert_eq!(after_reset.five_hour.remaining, 3);
}

#[test]
fn email_policy_normalizes_idn_and_matches_wildcards() {
    assert_eq!(normalize_email(" Alice@Example.COM ").unwrap(), "alice@example.com");
    let xn = normalize_email_domain("*.例え.jp", true).unwrap();
    assert!(xn.starts_with("*.xn--"));
    assert!(email_domain_allowed(
        "user@sub.edu.cn",
        "allowlist",
        &["*.edu.cn".to_string()]
    ));
    assert!(!email_domain_allowed(
        "user@edu.cn",
        "allowlist",
        &["*.edu.cn".to_string()]
    ));
}

#[test]
fn metadata_persona_and_group_mentions_work() {
    let dir = TempDir::new().unwrap();
    let db = Db::open(&temp_config(&dir)).unwrap();
    let settings = db.read(read_settings).unwrap();
    let meta = build_metadata_block(&settings, "Asia/Shanghai");
    assert!(meta.contains("当前日期："));
    assert!(meta.contains("农历日期："));
    assert!(meta.contains("当前节气："));

    let persona = UserPersona {
        enabled: true,
        name: "星光".to_string(),
        species: "独角兽".to_string(),
        pronouns: "她/her".to_string(),
        appearance: "淡紫鬓毛".to_string(),
        personality: "温和好奇".to_string(),
        background: "".to_string(),
    };
    let pblock = build_persona_block(Some(&persona));
    assert!(pblock.contains("星光"));
    assert!(!pblock.contains("background"));

    let make_char = |id: &str, name: &str, slug: &str| Character {
        id: id.into(),
        owner_id: None,
        name: name.into(),
        slug: slug.into(),
        description: "".into(),
        avatar: "".into(),
        color: "#315B52".into(),
        tags: vec![],
        personality: None,
        greeting: "".into(),
        provider_id: None,
        active: true,
        created_at: now_iso(),
    };
    let members = vec![
        make_char("c1", "Twilight", "twilight"),
        make_char("c2", "暮光闪闪", "twilight-zh"),
    ];
    let text = "请联系 admin@twilight.com，然后让 @Twilight. 不要急，或者 @暮光闪闪，你怎么看？@twilight.com 不应匹配";
    let hits = find_mentions(text, &members);
    assert_eq!(hits, vec!["c1", "c2"]);

    let mut q = GroupQueue::new("大家聊聊", &members, 4);
    assert_eq!(q.pop_next().as_deref(), Some("c1"));
    q.enqueue_mentions_from_reply("好呀，@暮光闪闪 你来补充吧", "c1", &members);
    assert_eq!(q.pop_next().as_deref(), Some("c2"));
    assert!(q.pop_next().is_none());

    let _ = Arc::new(db);
}
