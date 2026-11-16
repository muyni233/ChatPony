pub mod account;
pub mod admin;
pub mod auth;
pub mod chat;
pub mod helpers;
pub mod memories;
pub mod public;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, patch, post, put};

use crate::state::AppState;

pub fn api_router() -> Router<AppState> {
    Router::new()
        // Public
        .route("/api/health", get(public::health))
        .route("/api/bootstrap", get(public::bootstrap))
        .route("/api/characters", get(public::characters_public))
        .route("/api/registration-policy", get(public::registration_policy))
        .route("/api/announcements", get(public::announcements_public))
        .route("/api/avatars/{filename}", get(public::get_avatar))
        // Auth
        .route("/api/auth/send-code", post(auth::send_code))
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        // Account & Persona & Private Characters
        .route("/api/account", get(account::get_account).patch(account::patch_account))
        .route("/api/account/password", post(account::post_password))
        .route(
            "/api/account/persona",
            put(account::put_persona).patch(account::put_persona),
        )
        .route(
            "/api/account/avatar",
            post(account::upload_user_avatar).delete(account::remove_user_avatar),
        )
        .route(
            "/api/user-characters",
            get(account::get_user_characters).post(account::post_user_character),
        )
        .route(
            "/api/user-characters/{id}",
            patch(account::patch_user_character).delete(account::remove_user_character),
        )
        .route(
            "/api/user-characters/{id}/avatar",
            post(account::upload_user_char_avatar).delete(account::remove_user_char_avatar),
        )
        // Conversations & Chat & Attachments
        .route(
            "/api/conversations",
            get(chat::list_conversations).post(chat::post_conversation),
        )
        .route(
            "/api/conversations/{id}",
            get(chat::get_conversation)
                .patch(chat::patch_conversation)
                .delete(chat::remove_conversation),
        )
        .route(
            "/api/conversations/{id}/messages",
            post(chat::post_message).delete(chat::clear_messages),
        )
        .route("/api/conversations/{id}/clear", post(chat::clear_messages))
        .route("/api/conversations/{id}/attachments", post(chat::post_attachment))
        .route("/api/attachments/{id}", get(chat::get_attachment))
        // Memories
        .route(
            "/api/memories",
            get(memories::get_memories).post(memories::post_memory),
        )
        .route(
            "/api/memories/{id}",
            patch(memories::patch_memory).delete(memories::remove_memory),
        )
        .route("/api/memories/summarize", post(memories::summarize_memories))
        .route("/api/memories/recall-preview", post(memories::recall_preview))
        .route("/api/memories/reindex", post(memories::reindex_memories))
        // Admin
        .route("/api/admin/overview", get(admin::overview))
        .route(
            "/api/admin/settings",
            get(admin::get_settings)
                .patch(admin::patch_settings)
                .put(admin::patch_settings),
        )
        .route(
            "/api/admin/users",
            get(admin::list_users).post(admin::create_user),
        )
        .route("/api/admin/users/{id}", patch(admin::patch_user))
        .route("/api/admin/users/{id}/reset-quota", post(admin::post_reset_quota))
        .route(
            "/api/admin/characters",
            get(admin::list_characters).post(admin::create_character),
        )
        .route(
            "/api/admin/characters/{id}",
            patch(admin::patch_character).delete(admin::delete_character),
        )
        .route(
            "/api/admin/characters/{id}/avatar",
            post(admin::upload_character_avatar).delete(admin::clear_character_avatar),
        )
        .route(
            "/api/admin/suppliers",
            get(admin::list_suppliers).post(admin::create_supplier),
        )
        .route(
            "/api/admin/suppliers/{id}",
            patch(admin::patch_supplier).delete(admin::delete_supplier),
        )
        .route(
            "/api/admin/providers",
            get(admin::list_models).post(admin::create_model),
        )
        .route(
            "/api/admin/providers/{id}",
            patch(admin::patch_model).delete(admin::delete_model),
        )
        .route("/api/admin/providers/{id}/test", post(admin::test_model))
        .route(
            "/api/admin/models",
            get(admin::list_models).post(admin::create_model),
        )
        .route(
            "/api/admin/models/{id}",
            patch(admin::patch_model).delete(admin::delete_model),
        )
        .route("/api/admin/models/{id}/test", post(admin::test_model))
        .route(
            "/api/admin/embedding",
            get(admin::get_embedding)
                .put(admin::put_embedding)
                .patch(admin::put_embedding),
        )
        .route("/api/admin/embedding/test", post(admin::post_test_embedding))
        .route(
            "/api/admin/announcements",
            get(admin::list_announcements).post(admin::create_announcement),
        )
        .route(
            "/api/admin/announcements/{id}",
            patch(admin::patch_announcement).delete(admin::delete_announcement),
        )
        .route(
            "/api/admin/mail",
            get(admin::get_mail)
                .put(admin::put_mail)
                .patch(admin::put_mail),
        )
        .route("/api/admin/mail/test", post(admin::post_test_mail))
        .route("/api/admin/mail/deliveries", get(admin::get_mail_deliveries))
        .route(
            "/api/admin/audit",
            get(admin::get_audits).delete(admin::delete_all_audits),
        )
        .route("/api/admin/audit/stats", get(admin::audit_stats))
        .route("/api/admin/audit/{id}", get(admin::get_audit_detail))
        // Allow up to 12 MiB for avatar / image attachment uploads (individual handlers enforce 5/10 MiB)
        .layer(DefaultBodyLimit::max(12 * 1024 * 1024))
}
