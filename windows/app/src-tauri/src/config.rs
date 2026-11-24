use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiConfig {
    #[serde(default = "default_schema")]
    pub schema: u32,
    #[serde(default)]
    pub last_page: u32,
    #[serde(default)]
    pub quota_refresh_minutes: u32,
    #[serde(default = "default_true")]
    pub hud_enabled: bool,
    #[serde(default)]
    pub auto_pricing_sync_enabled: bool,
    #[serde(default)]
    pub launch_antigravity_on_start: bool,
    #[serde(default)]
    pub sync_antigravity_lifecycle: bool,
    #[serde(default)]
    pub auto_update_enabled: bool,
    #[serde(default)]
    pub accounts_collapsed: bool,
    #[serde(default)]
    pub menu_selected_tab: u32,
    #[serde(default)]
    pub menu_usage_period: u32,
    #[serde(default = "default_env_all")]
    pub menu_usage_environment_id: String,
    #[serde(default = "default_trend_metric")]
    pub menu_trend_metric: String,
    #[serde(default = "default_channel")]
    pub application_channel: String,
    #[serde(default)]
    pub app_language: Option<String>,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
    #[serde(default = "default_proxy_mode")]
    pub antigravity_proxy_mode: String,
    #[serde(default)]
    pub antigravity_proxy_manual_url: String,
    #[serde(default)]
    pub privacy_mask_accounts: bool,
}

fn default_schema() -> u32 {
    2
}
fn default_true() -> bool {
    true
}
fn default_env_all() -> String {
    "all".to_string()
}
fn default_trend_metric() -> String {
    "tokens".to_string()
}
fn default_channel() -> String {
    "stable".to_string()
}
fn default_theme_mode() -> String {
    "system".to_string()
}
fn default_proxy_mode() -> String {
    "off".to_string()
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            schema: 2,
            last_page: 0,
            quota_refresh_minutes: 0,
            hud_enabled: true,
            auto_pricing_sync_enabled: false,
            launch_antigravity_on_start: false,
            sync_antigravity_lifecycle: false,
            auto_update_enabled: false,
            accounts_collapsed: false,
            menu_selected_tab: 0,
            menu_usage_period: 0,
            menu_usage_environment_id: "all".to_string(),
            menu_trend_metric: "tokens".to_string(),
            application_channel: "stable".to_string(),
            app_language: None,
            theme_mode: "system".to_string(),
            antigravity_proxy_mode: "off".to_string(),
            antigravity_proxy_manual_url: String::new(),
            privacy_mask_accounts: false,
        }
    }
}

const MAX_CONFIG_BYTES: u64 = 1_048_576;

pub fn load_config(state_dir: &Path) -> UiConfig {
    let config_path = state_dir.join("config.json");
    let meta = match fs::symlink_metadata(&config_path) {
        Ok(m) => m,
        Err(_) => return UiConfig::default(),
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() || meta.len() > MAX_CONFIG_BYTES
    {
        return UiConfig::default();
    }
    let raw = match fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return UiConfig::default(),
    };
    let mut cfg: UiConfig = serde_json::from_str(&raw).unwrap_or_default();
    cfg.application_channel = "stable".to_string();
    cfg.menu_selected_tab = cfg.menu_selected_tab.min(2);
    cfg.menu_usage_period = cfg.menu_usage_period.min(3);
    if cfg.menu_usage_environment_id.trim().is_empty() {
        cfg.menu_usage_environment_id = "all".to_string();
    }
    if cfg.menu_trend_metric != "requests" {
        cfg.menu_trend_metric = "tokens".to_string();
    }
    if !matches!(cfg.theme_mode.as_str(), "system" | "light" | "dark") {
        cfg.theme_mode = "system".to_string();
    }
    if !matches!(cfg.antigravity_proxy_mode.as_str(), "off" | "system" | "manual") {
        cfg.antigravity_proxy_mode = "off".to_string();
    }
    cfg.antigravity_proxy_manual_url = cfg.antigravity_proxy_manual_url.trim().to_string();
    cfg
}

/// Atomically save `UiConfig` while preserving any external fields in `config.json`
/// (matching macOS `ConfigurationStore.save()`).
pub fn save_config(state_dir: &Path, cfg: &UiConfig) -> Result<(), String> {
    use std::io::Write;
    fs::create_dir_all(state_dir).map_err(|e| format!("无法创建数据目录: {}", e))?;
    let config_path = state_dir.join("config.json");
    if let Ok(meta) = fs::symlink_metadata(&config_path) {
        if meta.file_type().is_symlink() || !meta.file_type().is_file() {
            return Err("配置文件路径异常（符号链接或目录），已拒绝写入".to_string());
        }
    }

    let mut merged: Map<String, Value> = fs::symlink_metadata(&config_path)
        .ok()
        .filter(|m| m.file_type().is_file() && m.len() <= MAX_CONFIG_BYTES)
        .and_then(|_| fs::read_to_string(&config_path).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let mut clean = cfg.clone();
    clean.schema = 2;
    clean.application_channel = "stable".to_string();
    if !matches!(clean.antigravity_proxy_mode.as_str(), "off" | "system" | "manual") {
        clean.antigravity_proxy_mode = "off".to_string();
    }
    clean.antigravity_proxy_manual_url = clean.antigravity_proxy_manual_url.trim().to_string();
    let known = serde_json::to_value(&clean)
        .map_err(|e| format!("配置序列化失败: {}", e))?;
    if let Some(obj) = known.as_object() {
        for (k, v) in obj {
            if v.is_null() {
                merged.remove(k);
            } else {
                merged.insert(k.clone(), v.clone());
            }
        }
    }

    let payload = serde_json::to_string_pretty(&Value::Object(merged))
        .map_err(|e| format!("配置格式化失败: {}", e))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = state_dir.join(format!("config-{}-{}.tmp", std::process::id(), stamp));
    let write_res = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)?;
        f.write_all(payload.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("无法写入临时配置: {}", e));
    }

    // Windows atomic rename with short retry on EPERM/EBUSY
    let mut last_err = None;
    for attempt in 0..5u64 {
        match fs::rename(&tmp_path, &config_path) {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
                if fs::symlink_metadata(&config_path)
                    .map(|m| m.file_type().is_file())
                    .unwrap_or(false)
                {
                    let _ = fs::remove_file(&config_path);
                    if fs::rename(&tmp_path, &config_path).is_ok() {
                        last_err = None;
                        break;
                    }
                }
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(20 * (attempt + 1)));
            }
        }
    }
    if let Some(err) = last_err {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("配置保存失败: {}", err));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_state_dir(suffix: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "gb-config-test-{}-{}-{}",
            std::process::id(),
            stamp,
            suffix
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn default_ui_config_sets_privacy_mask_accounts_false() {
        let cfg = UiConfig::default();
        assert!(!cfg.privacy_mask_accounts);
    }

    #[test]
    fn privacy_mask_accounts_serializes_as_camel_case() {
        let mut cfg = UiConfig::default();
        let default_json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(default_json.get("privacyMaskAccounts"), Some(&Value::Bool(false)));
        assert!(default_json.get("privacy_mask_accounts").is_none());

        cfg.privacy_mask_accounts = true;
        let enabled_json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(enabled_json.get("privacyMaskAccounts"), Some(&Value::Bool(true)));
    }

    #[test]
    fn load_config_backward_compatible_when_privacy_mask_accounts_omitted() {
        let dir = temp_state_dir("compat");
        let legacy_json = serde_json::json!({
            "schema": 2,
            "lastPage": 1,
            "hudEnabled": false,
            "externalCustomKey": "preserved"
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&legacy_json).unwrap(),
        )
        .unwrap();

        let mut loaded = load_config(&dir);
        assert!(!loaded.privacy_mask_accounts);
        assert_eq!(loaded.last_page, 1);
        assert!(!loaded.hud_enabled);

        loaded.privacy_mask_accounts = true;
        save_config(&dir, &loaded).unwrap();

        let reloaded = load_config(&dir);
        assert!(reloaded.privacy_mask_accounts);

        let raw: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        assert_eq!(raw.get("privacyMaskAccounts"), Some(&Value::Bool(true)));
        assert_eq!(
            raw.get("externalCustomKey"),
            Some(&Value::String("preserved".to_string()))
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
