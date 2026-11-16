use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use rand::RngCore;

use crate::config::Config;
use crate::error::{AppError, AppResult};

pub struct CryptoService {
    database_path: String,
    supplied_key: Option<String>,
    ephemeral_key: Mutex<Option<[u8; 32]>>,
}

impl CryptoService {
    pub fn new(config: &Config) -> Self {
        Self {
            database_path: config.database_path.clone(),
            supplied_key: config.encryption_key.clone(),
            ephemeral_key: Mutex::new(None),
        }
    }

    fn key(&self) -> AppResult<[u8; 32]> {
        if let Some(supplied) = &self.supplied_key {
            let trimmed = supplied.trim();
            if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                let bytes = hex::decode(trimmed).map_err(|_| invalid_env_key())?;
                return bytes.try_into().map_err(|_| invalid_env_key());
            }
            if trimmed.len() == 44 && trimmed.ends_with('=') {
                let bytes = STANDARD.decode(trimmed).map_err(|_| invalid_env_key())?;
                if bytes.len() == 32 {
                    return bytes.try_into().map_err(|_| invalid_env_key());
                }
            }
            return Err(invalid_env_key());
        }

        if self.database_path == ":memory:" {
            let mut guard = self.ephemeral_key.lock().unwrap();
            if let Some(k) = *guard {
                return Ok(k);
            }
            let mut k = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut k);
            *guard = Some(k);
            return Ok(k);
        }

        let db_path = Path::new(&self.database_path);
        let abs = if db_path.is_absolute() {
            db_path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(db_path)
        };
        let dir = abs.parent().unwrap_or_else(|| Path::new("."));
        let key_path = dir.join(".encryption-key");

        if let Some(existing) = read_key_file(&key_path)? {
            return Ok(existing);
        }

        fs::create_dir_all(dir).map_err(|_| write_key_failed())?;
        let mut rand_suffix = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut rand_suffix);
        let tmp_path = dir.join(format!(".encryption-key.{}.tmp", hex::encode(rand_suffix)));

        let mut new_key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut new_key);

        let write_result = (|| -> AppResult<[u8; 32]> {
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = opts.open(&tmp_path).map_err(|_| write_key_failed())?;
            file.write_all(&new_key).map_err(|_| write_key_failed())?;
            file.sync_all().map_err(|_| write_key_failed())?;
            drop(file);

            match fs::hard_link(&tmp_path, &key_path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(write_key_failed()),
            }
            read_key_file(&key_path)?.ok_or_else(write_key_failed)
        })();

        let _ = fs::remove_file(&tmp_path);
        write_result
    }

    pub fn encrypt(&self, value: &str) -> AppResult<String> {
        if value.is_empty() {
            return Ok(String::new());
        }
        let key = self.key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| invalid_env_key())?;
        let mut iv = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);
        let mut buf = value.as_bytes().to_vec();
        let tag = cipher
            .encrypt_in_place_detached(nonce, b"", &mut buf)
            .map_err(|_| AppError::internal())?;
        Ok(format!(
            "v1:{}:{}:{}",
            URL_SAFE_NO_PAD.encode(iv),
            URL_SAFE_NO_PAD.encode(tag.as_slice()),
            URL_SAFE_NO_PAD.encode(&buf)
        ))
    }

    pub fn decrypt(&self, value: &str) -> AppResult<String> {
        if value.is_empty() {
            return Ok(String::new());
        }
        let mut parts = value.split(':');
        let version = parts.next();
        let nonce_b64 = parts.next();
        let tag_b64 = parts.next();
        let payload_b64 = parts.next();
        if version != Some("v1")
            || nonce_b64.is_none()
            || tag_b64.is_none()
            || payload_b64.is_none()
            || parts.next().is_some()
        {
            return Err(AppError::service_unavailable(
                "CREDENTIAL_DECRYPT_FAILED",
                "无效的加密凭据。",
            ));
        }
        let nonce_bytes = URL_SAFE_NO_PAD
            .decode(nonce_b64.unwrap())
            .map_err(|_| invalid_credential())?;
        let tag_bytes = URL_SAFE_NO_PAD
            .decode(tag_b64.unwrap())
            .map_err(|_| invalid_credential())?;
        let mut buf = URL_SAFE_NO_PAD
            .decode(payload_b64.unwrap())
            .map_err(|_| invalid_credential())?;

        if nonce_bytes.len() != 12 || tag_bytes.len() != 16 {
            return Err(invalid_credential());
        }
        let key = self.key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| invalid_env_key())?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let tag = Tag::from_slice(&tag_bytes);
        cipher
            .decrypt_in_place_detached(nonce, b"", &mut buf, tag)
            .map_err(|_| invalid_credential())?;
        String::from_utf8(buf).map_err(|_| invalid_credential())
    }
}

fn read_key_file(key_path: &Path) -> AppResult<Option<[u8; 32]>> {
    match fs::read(key_path) {
        Ok(bytes) => {
            if bytes.len() != 32 {
                return Err(AppError::service_unavailable(
                    "ENCRYPTION_KEY_FILE_INVALID",
                    "数据库目录中的 .encryption-key 文件无效。请恢复原密钥文件，系统不会覆盖它。",
                ));
            }
            let arr: [u8; 32] = bytes.try_into().unwrap();
            Ok(Some(arr))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(AppError::service_unavailable(
            "ENCRYPTION_KEY_READ_FAILED",
            "无法读取数据库目录中的 .encryption-key，请检查服务进程的文件访问权限。",
        )),
    }
}

fn invalid_env_key() -> AppError {
    AppError::service_unavailable(
        "ENCRYPTION_KEY_INVALID",
        "服务器的 ENCRYPTION_KEY 格式无效，应为 32 字节密钥的十六进制或 Base64 编码。",
    )
}

fn write_key_failed() -> AppError {
    AppError::service_unavailable(
        "ENCRYPTION_KEY_WRITE_FAILED",
        "无法在数据库目录保存加密密钥。请赋予该目录写入权限，或配置有效的 ENCRYPTION_KEY。",
    )
}

fn invalid_credential() -> AppError {
    AppError::service_unavailable("CREDENTIAL_DECRYPT_FAILED", "加密凭据无法解密。")
}
