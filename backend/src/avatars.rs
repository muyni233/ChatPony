use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use rusqlite::{Connection, OptionalExtension};

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::models::{User, new_id};

pub const MAX_AVATAR_UPLOAD_BYTES: usize = 5 * 1024 * 1024;
const MAX_AVATAR_PIXELS: u64 = 16_000_000;
const MAX_AVATAR_DIM: u32 = 8192;
const AVATAR_SIZE: u32 = 256;

pub fn sniff_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(ImageFormat::Png);
    }
    if bytes.len() >= 3 && bytes[0..3] == [0xff, 0xd8, 0xff] {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::WebP);
    }
    None
}

pub fn decode_and_normalize_image(
    bytes: &[u8],
    max_pixels: u64,
    max_dim: u32,
) -> AppResult<DynamicImage> {
    let format = sniff_image_format(bytes).ok_or_else(|| {
        AppError::validation("仅支持 PNG、JPG、WebP 或 GIF 格式的图片。")
    })?;

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(max_dim);
    limits.max_image_height = Some(max_dim);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);

    let mut decoder = reader.into_decoder().map_err(|_| {
        AppError::validation("图片文件损坏或尺寸超出限制。")
    })?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || (u64::from(w) * u64::from(h)) > max_pixels || w > max_dim || h > max_dim
    {
        return Err(AppError::validation("图片分辨率过大或尺寸无效。"));
    }

    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder).map_err(|_| {
        AppError::validation("无法解码图片内容，请更换其他图片。")
    })?;
    if let Some(ori) = orientation {
        img.apply_orientation(ori);
    }
    Ok(img)
}

pub fn encode_lossless_webp(img: &DynamicImage) -> AppResult<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::WebP).map_err(|err| {
        tracing::error!("Failed to encode WebP image: {:?}", err);
        AppError::internal()
    })?;
    Ok(out.into_inner())
}

pub fn process_avatar_bytes(bytes: &[u8]) -> AppResult<Vec<u8>> {
    if bytes.is_empty() {
        return Err(AppError::validation("请选择要上传的头像图片。"));
    }
    if bytes.len() > MAX_AVATAR_UPLOAD_BYTES {
        return Err(AppError::validation("头像图片大小不能超过 5 MB。"));
    }
    let img = decode_and_normalize_image(bytes, MAX_AVATAR_PIXELS, MAX_AVATAR_DIM)?;
    let resized = img.resize_to_fill(AVATAR_SIZE, AVATAR_SIZE, FilterType::Lanczos3);
    encode_lossless_webp(&resized)
}

pub fn is_valid_avatar_filename(filename: &str) -> bool {
    if filename.is_empty() || filename.len() > 128 || !filename.ends_with(".webp") {
        return false;
    }
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return false;
    }
    filename
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub fn extract_avatar_filename(url: &str) -> Option<&str> {
    let trimmed = url.trim();
    let name = trimmed.strip_prefix("/api/avatars/")?;
    if is_valid_avatar_filename(name) {
        Some(name)
    } else {
        None
    }
}

pub fn avatar_file_path(config: &Config, filename: &str) -> AppResult<PathBuf> {
    if !is_valid_avatar_filename(filename) {
        return Err(AppError::not_found("AVATAR_NOT_FOUND", "头像不存在。"));
    }
    Ok(config.avatar_directory().join(filename))
}

pub fn save_avatar_file(config: &Config, bytes: &[u8]) -> AppResult<String> {
    let webp = tokio::task::block_in_place(|| process_avatar_bytes(bytes))?;
    let dir = config.avatar_directory();
    fs::create_dir_all(&dir).map_err(|err| {
        tracing::error!("Failed to create avatar dir {:?}: {:?}", dir, err);
        AppError::internal()
    })?;
    let filename = format!("{}.webp", new_id());
    let final_path = dir.join(&filename);
    let tmp_path = dir.join(format!(".tmp-{filename}"));
    fs::write(&tmp_path, &webp).and_then(|()| fs::rename(&tmp_path, &final_path)).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        tracing::error!("Failed to write avatar {:?}: {:?}", final_path, err);
        AppError::internal()
    })?;
    Ok(format!("/api/avatars/{filename}"))
}

pub fn delete_avatar_by_url(config: &Config, url: &str) {
    let Some(filename) = extract_avatar_filename(url) else {
        return;
    };
    let path: PathBuf = config.avatar_directory().join(filename);
    if Path::new(&path).is_file() {
        let _ = fs::remove_file(&path);
    }
}

pub fn can_read_avatar(
    conn: &Connection,
    avatar_url: &str,
    viewer: Option<&User>,
) -> AppResult<(bool, bool)> {
    // Returns (allowed, is_private)
    let owner: Option<(Option<String>,)> = conn
        .query_row(
            "SELECT owner_id FROM characters WHERE avatar=? AND deleted_at IS NULL LIMIT 1",
            rusqlite::params![avatar_url],
            |r| Ok((r.get(0)?,)),
        )
        .optional()?;

    if let Some((Some(owner_id),)) = owner {
        let allowed = viewer
            .map(|u| u.id == owner_id || u.role == "admin")
            .unwrap_or(false);
        return Ok((allowed, true));
    }
    Ok((true, false))
}
