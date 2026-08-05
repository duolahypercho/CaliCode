use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_CONFIG_PATH: &str = "~/.cali/config.yaml";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    pub model: ModelConfig,
    pub providers: Vec<ProviderPreset>,
    pub projects_dir: Option<String>,
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
        },
        ProviderPreset {
            id: "openrouter".into(),
            label: "OpenRouter".into(),
            base_url: "https://openrouter.ai/api/v1".into(),
            api_key_env: "CALI_OPENROUTER_API_KEY".into(),
        },
        ProviderPreset {
            id: "local".into(),
            label: "Local".into(),
            base_url: "http://127.0.0.1:11434/v1".into(),
            api_key_env: "CALI_LOCAL_API_KEY".into(),
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

pub fn projects_root(config: &AppConfig) -> PathBuf {
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
    std::env::var(&key).unwrap_or_default()
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
        let loaded: AppConfig = serde_yaml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.model.default, "test-model");
    }

    #[test]
    fn tilde_expands() {
        let p = expand_tilde("~/cali");
        assert!(p.is_absolute());
    }
}
