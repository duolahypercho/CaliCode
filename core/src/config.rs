use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_CONFIG_PATH: &str = "~/.cali/config.yaml";
pub const CODEX_ROUTER_PROVIDER_ID: &str = "codex-router";
pub const CODEX_ROUTER_BASE_URL: &str = "http://127.0.0.1:4100/v1";
const CODEX_ROUTER_KEY_ENV: &str = "CALI_CODEX_ROUTER_KEY";
const CODEX_ROUTER_STATE_KEY: &str = "~/.codex/codex-router/internal-secret";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    pub model: ModelConfig,
    pub providers: Vec<ProviderPreset>,
    pub projects_dir: Option<String>,
    /// Absolute paths of folders opened as workspaces, so an attached project
    /// survives a core restart instead of having to be re-opened by hand.
    #[serde(default)]
    pub workspaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelConfig {
    pub default: String,
    pub provider: String,
    pub base_url: String,
    pub api_key_env: String,
    pub temperature: f64,
    pub max_tokens: Option<u32>,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            default: env_or("CALI_MODEL", "gpt-4.1-mini"),
            provider: env_or("CALI_PROVIDER", "openai"),
            base_url: env_or("CALI_OPENAI_BASE_URL", "https://api.openai.com/v1"),
            api_key_env: "CALI_OPENAI_API_KEY".to_string(),
            temperature: 0.4,
            max_tokens: Some(4096),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderPreset {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub api_key_env: String,
    #[serde(default)]
    pub models: Vec<String>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_path() -> PathBuf {
    std::env::var("CALI_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| expand_tilde(DEFAULT_CONFIG_PATH))
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(path)
    }
}

pub fn default_providers() -> Vec<ProviderPreset> {
    vec![
        ProviderPreset {
            id: "openai".into(),
            label: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key_env: "CALI_OPENAI_API_KEY".into(),
            models: vec![
                "gpt-4.1-mini".into(),
                "gpt-4.1".into(),
                "gpt-4o".into(),
                "o3-mini".into(),
            ],
        },
        ProviderPreset {
            id: CODEX_ROUTER_PROVIDER_ID.into(),
            label: "Codex Router".into(),
            base_url: CODEX_ROUTER_BASE_URL.into(),
            api_key_env: CODEX_ROUTER_KEY_ENV.into(),
            models: vec![
                "deepseek-v4-flash".into(),
                "deepseek-v3.2".into(),
                "gpt-4.1-mini".into(),
                "gpt-4.1".into(),
                "claude-sonnet-4-5".into(),
                "gemini-2.5-pro".into(),
            ],
        },
        ProviderPreset {
            id: "openrouter".into(),
            label: "OpenRouter".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            api_key_env: "CALI_OPENROUTER_API_KEY".into(),
            models: vec![
                "deepseek/deepseek-chat".into(),
                "openai/gpt-4o".into(),
                "anthropic/claude-sonnet-4-5".into(),
            ],
        },
        ProviderPreset {
            id: "local".into(),
            label: "Local".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            api_key_env: "CALI_LOCAL_API_KEY".into(),
            models: vec![
                "llama3.2".into(),
                "qwen2.5-coder:7b".into(),
                "deepseek-r1:7b".into(),
            ],
        },
    ]
}

pub fn load() -> Result<AppConfig> {
    let path = config_path();
    let mut config = if path.exists() {
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read config {}", path.display()))?;
        serde_yaml::from_str(&text).unwrap_or_default()
    } else {
        AppConfig::default()
    };
    if config.providers.is_empty() {
        config.providers = default_providers();
    } else {
        let defaults = default_providers();
        for preset in default_providers() {
            if !config
                .providers
                .iter()
                .any(|existing| existing.id == preset.id)
            {
                config.providers.push(preset);
            }
        }
        for preset in &mut config.providers {
            if preset.models.is_empty() {
                if let Some(default) = defaults.iter().find(|candidate| candidate.id == preset.id) {
                    preset.models = default.models.clone();
                }
            }
        }
    }
    Ok(config)
}

pub fn save(config: &AppConfig) -> Result<PathBuf> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let yaml = serde_yaml::to_string(config)?;
    std::fs::write(&path, yaml)?;
    Ok(path)
}

/// Resolves where projects live.
///
/// `CALI_PROJECTS_DIR` wins over the config file so a test run can be pointed
/// at a scratch directory. Without it the e2e suite writes to the user's real
/// `~/.cali/projects`, permanently mutating the shared `starter` project on
/// every run — enough accumulated drift had already turned a passing
/// assertion into a failing one.
pub fn projects_root(config: &AppConfig) -> PathBuf {
    if let Some(override_dir) = std::env::var_os("CALI_PROJECTS_DIR") {
        return expand_tilde(&override_dir.to_string_lossy());
    }
    config
        .projects_dir
        .as_deref()
        .map(expand_tilde)
        .unwrap_or_else(|| expand_tilde("~/.cali/projects"))
}

pub fn api_key(config: &AppConfig) -> String {
    let key = config
        .providers
        .iter()
        .find(|p| p.id == config.model.provider)
        .map(|p| p.api_key_env.clone())
        .unwrap_or_else(|| config.model.api_key_env.clone());
    std::env::var(&key).unwrap_or_default().trim().to_string()
}

/// The router keeps its loopback service key in protected state, so CaliCode can
/// reuse the router's configured providers without duplicating credentials.
pub fn router_key() -> String {
    if let Some(key) = std::env::var(CODEX_ROUTER_KEY_ENV)
        .ok()
        .map(|value| value.trim().to_string())
    {
        if !key.is_empty() {
            return key;
        }
    }
    std::fs::read_to_string(expand_tilde(CODEX_ROUTER_STATE_KEY))
        .ok()
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrip() {
        let mut config = AppConfig::default();
        config.model.default = "test-model".into();
        let path = tempfile::tempdir().unwrap().path().join("config.yaml");
        let yaml = serde_yaml::to_string(&config).unwrap();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, yaml).unwrap();
        let loaded: AppConfig =
            serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.model.default, "test-model");
    }

    #[test]
    fn tilde_expands() {
        let p = expand_tilde("~/cali");
        assert!(p.is_absolute());
    }

    #[test]
    fn default_providers_include_codex_router() {
        let providers = default_providers();
        let preset = providers
            .iter()
            .find(|p| p.id == crate::config::CODEX_ROUTER_PROVIDER_ID)
            .expect("codex-router preset should exist");
        assert_eq!(preset.base_url, crate::config::CODEX_ROUTER_BASE_URL);
        assert!(!preset.models.is_empty());
    }

    #[test]
    fn api_key_prefers_the_presets_env_var() {
        let mut config = AppConfig {
            providers: default_providers(),
            ..Default::default()
        };
        config.model.provider = crate::config::CODEX_ROUTER_PROVIDER_ID.into();
        std::env::set_var("CALI_CODEX_ROUTER_KEY", "env-key");
        assert_eq!(api_key(&config), "env-key");
        std::env::remove_var("CALI_CODEX_ROUTER_KEY");
    }
}
