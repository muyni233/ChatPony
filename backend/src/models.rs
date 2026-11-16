use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Protocol {
    #[serde(rename = "openai-completions")]
    OpenAiCompletions,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompletions => "openai-completions",
            Self::OpenAiResponses => "openai-responses",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "openai-responses" => Self::OpenAiResponses,
            "anthropic" => Self::Anthropic,
            "gemini" => Self::Gemini,
            _ => Self::OpenAiCompletions,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Language,
    Embedding,
}

impl ModelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Language => "language",
            Self::Embedding => "embedding",
        }
    }
    pub fn from_db(s: &str) -> Self {
        if s == "embedding" {
            Self::Embedding
        } else {
            Self::Language
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelCapability {
    Text,
    Image,
    Audio,
    File,
}

impl ModelCapability {
    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "text" => Some(Self::Text),
            "image" => Some(Self::Image),
            "audio" => Some(Self::Audio),
            "file" => Some(Self::File),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    Default,
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "none" => Self::None,
            "minimal" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::Xhigh,
            "max" => Self::Max,
            _ => Self::Default,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPersona {
    pub enabled: bool,
    pub name: String,
    pub species: String,
    pub pronouns: String,
    pub appearance: String,
    pub personality: String,
    pub background: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub disabled: bool,
    pub timezone: String,
    pub created_at: String,
    pub email_verified_at: Option<String>,
    pub avatar: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<UserPersona>,
    pub limit5h: i64,
    pub limit7d: i64,
    pub character_slots: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub owner_id: Option<String>,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub avatar: String,
    pub color: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub personality: Option<String>,
    pub greeting: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCharacter {
    #[serde(flatten)]
    pub character: Character,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_input: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotsInfo {
    pub used: i64,
    pub limit: i64,
    pub remaining: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCharacters {
    pub items: Vec<Character>,
    pub slots: SlotsInfo,
    pub models: Vec<ModelOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub model: String,
    pub kind: ModelKind,
    pub capabilities: Vec<ModelCapability>,
    pub reasoning_effort: ReasoningEffort,
    pub thinking_budget: Option<i64>,
    pub supplier_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supplier_name: Option<String>,
    pub supplier_active: bool,
    pub has_key: bool,
    pub active: bool,
    pub context_window: i64,
    pub max_output: i64,
    pub temperature: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierConfig {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub has_key: bool,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub kind: String,
    pub character_ids: Vec<String>,
    pub summary: String,
    pub max_rounds: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub character_id: Option<String>,
    pub content: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Note,
    Fact,
    Preference,
    Relationship,
    Event,
    Plan,
    Summary,
}

impl MemoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Relationship => "relationship",
            Self::Event => "event",
            Self::Plan => "plan",
            Self::Summary => "summary",
        }
    }

    pub fn from_db(s: &str) -> Self {
        match s {
            "fact" => Self::Fact,
            "preference" => Self::Preference,
            "relationship" => Self::Relationship,
            "event" => Self::Event,
            "plan" => Self::Plan,
            "summary" => Self::Summary,
            _ => Self::Note,
        }
    }

    pub fn label_zh(self) -> &'static str {
        match self {
            Self::Note => "笔记",
            Self::Fact => "事实",
            Self::Preference => "偏好",
            Self::Relationship => "关系",
            Self::Event => "经历",
            Self::Plan => "约定",
            Self::Summary => "总结",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub user_id: String,
    pub character_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_color: Option<String>,
    pub content: String,
    pub source: String,
    pub kind: MemoryKind,
    pub importance: f64,
    pub status: String,
    pub access_count: i64,
    pub last_accessed_at: Option<String>,
    pub expires_at: Option<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallResult {
    pub id: String,
    pub content: String,
    pub kind: MemoryKind,
    pub importance: f64,
    pub score: f64,
    pub relevance: f64,
    pub routes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingConfig {
    pub model_id: String,
    pub supplier_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supplier_name: Option<String>,
    pub supplier_active: bool,
    pub protocol: String,
    pub enabled: bool,
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
    pub top_k: i64,
    pub min_similarity: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub id: String,
    pub title: String,
    pub content: String,
    pub pinned: bool,
    pub published: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub used: i64,
    pub limit: i64,
    pub remaining: i64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub five_hour: QuotaWindow,
    pub seven_day: QuotaWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSettings {
    pub registration_open: bool,
    pub default_limit5h: i64,
    pub default_limit7d: i64,
    pub default_character_slots: i64,
    pub max_group_rounds: i64,
    pub site_description: String,
    pub bubble_delimiter: String,
    pub hidden_symbols: Vec<String>,
    pub require_email_verification: bool,
    pub email_domain_mode: String,
    pub email_domains: Vec<String>,
    pub audit_capture_content: bool,
    pub audit_retention_days: i64,
    pub compression_trigger_rounds: i64,
    pub compression_keep_rounds: i64,
    pub compression_model_id: String,
    pub memory_summary_interval: i64,
    pub memory_summary_model_id: String,
    pub automatic_memory_enabled: bool,
    pub metadata_enabled: bool,
    pub metadata_fields: Vec<String>,
    pub metadata_timezone: String,
    pub metadata_custom: String,
    pub streaming_enabled: bool,
    pub image_input_enabled: bool,
    pub max_images_per_message: i64,
    pub action_style_enabled: bool,
    pub action_markers: Vec<String>,
    pub action_hide_markers: bool,
    pub memory_structured_extraction: bool,
    pub memory_recall_top_k: i64,
    pub memory_keyword_weight: f64,
    pub memory_decay_rate: f64,
    pub memory_archive_threshold: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailConfig {
    pub host: String,
    pub port: u16,
    pub secure: bool,
    #[serde(rename = "requireTLS")]
    pub require_tls: bool,
    pub username: String,
    pub has_password: bool,
    pub from_email: String,
    pub from_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDelivery {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub recipient: String,
    pub smtp_host: String,
    pub smtp_port: i64,
    pub from_email: String,
    pub stage: String,
    pub code: Option<String>,
    pub command: Option<String>,
    pub smtp_code: Option<i64>,
    pub enhanced_status: Option<String>,
    pub response: Option<String>,
    pub summary: String,
    pub hint: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDeliveryList {
    pub items: Vec<MailDelivery>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub retention_days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAudit {
    pub id: String,
    pub kind: String,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub conversation_id: Option<String>,
    pub character_id: Option<String>,
    pub character_name: Option<String>,
    pub supplier_id: Option<String>,
    pub supplier_name: Option<String>,
    pub model_id: Option<String>,
    pub protocol: String,
    pub model: String,
    pub endpoint: String,
    pub status: String,
    pub http_status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub request_id: Option<String>,
    pub attempt: i64,
    pub request_truncated: bool,
    pub response_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAuditDetail {
    #[serde(flatten)]
    pub meta: RequestAudit,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAuditList {
    pub items: Vec<RequestAudit>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestAuditStats {
    pub total: i64,
    pub success: i64,
    pub failed: i64,
    pub pending: i64,
    pub avg_duration_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStats {
    pub conversations: i64,
    pub messages: i64,
    pub memories: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub user: Option<User>,
    pub characters: Vec<Character>,
    pub conversations: Vec<Conversation>,
    pub announcements: Vec<Announcement>,
    pub quota: Option<QuotaSnapshot>,
    pub settings: PlatformSettings,
    pub stats: PlatformStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    pub conversation: Conversation,
    pub characters: Vec<ConversationCharacter>,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminOverview {
    pub users: i64,
    pub characters: i64,
    pub conversations: i64,
    pub calls: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ChatEvent {
    User {
        message: Message,
    },
    Status {
        text: String,
        #[serde(rename = "characterId", skip_serializing_if = "Option::is_none")]
        character_id: Option<String>,
    },
    Message {
        message: Message,
        #[serde(rename = "streamId", skip_serializing_if = "Option::is_none")]
        stream_id: Option<String>,
    },
    StreamStart {
        #[serde(rename = "streamId")]
        stream_id: String,
        #[serde(rename = "characterId")]
        character_id: String,
    },
    Delta {
        #[serde(rename = "streamId")]
        stream_id: String,
        text: String,
    },
    StreamEnd {
        #[serde(rename = "streamId")]
        stream_id: String,
    },
    Error {
        code: String,
        message: String,
    },
    Done {
        quota: QuotaSnapshot,
        rounds: i64,
        limited: bool,
    },
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn iso_from_utc(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
