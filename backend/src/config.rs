use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub database_path: String,
    pub encryption_key: Option<String>,
    pub trust_proxy: bool,
    pub host: String,
    pub port: u16,
    pub static_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let database_path = env::var("DATABASE_PATH")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "./data/chatpony.db".to_string());
        let encryption_key = env::var("ENCRYPTION_KEY")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let trust_proxy = env::var("TRUST_PROXY")
            .map(|v| v.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let host = env::var("HOST")
            .or_else(|_| env::var("HOSTNAME"))
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let port = env::var("PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|&p| p > 0)
            .unwrap_or(3000);
        let static_dir = env::var("CHATPONY_STATIC_DIR")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_static_dir);

        Self {
            database_path,
            encryption_key,
            trust_proxy,
            host,
            port,
            static_dir,
        }
    }

    pub fn avatar_directory(&self) -> PathBuf {
        if self.database_path == ":memory:" {
            return PathBuf::from("./data/avatars");
        }
        let db = Path::new(&self.database_path);
        let abs = if db.is_absolute() {
            db.to_path_buf()
        } else {
            env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(db)
        };
        abs.parent()
            .unwrap_or_else(|| Path::new("."))
            .join("avatars")
    }
}

fn default_static_dir() -> PathBuf {
    for candidate in ["./frontend/dist", "../frontend/dist", "./static"] {
        let p = PathBuf::from(candidate);
        if p.is_dir() {
            return p;
        }
    }
    PathBuf::from("./frontend/dist")
}
