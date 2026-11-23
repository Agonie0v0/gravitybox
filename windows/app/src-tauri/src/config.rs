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
    pub sync_antigravity_lifecycle: bool,
    #[serde(default)]
    pub auto_update_enabled: bool,
    #[serde(default)]
    pub accounts_collapsed: bool,
    #[serde(default)]
    pub menu_selected_tab: u32,
    #[serde(default)]
    pub menu_usage_period: u32,
    #[serde(default = "default_trend_metric")]
    pub menu_trend_metric: String,
    #[serde(default = "default_channel")]
    pub application_channel: String,
    #[serde(default)]
    pub app_language: Option<String>,
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
}

fn default_schema() -> u32 {
    2
}
fn default_true() -> bool {
    true
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

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            schema: 2,
            last_page: 0,
            quota_refresh_minutes: 0,
            hud_enabled: true,
            auto_pricing_sync_enabled: false,
            sync_antigravity_lifecycle: false,
            auto_update_enabled: false,
            accounts_collapsed: false,
            menu_selected_tab: 0,
            menu_usage_period: 0,
            menu_trend_metric: "tokens".to_string(),
            application_channel: "stable".to_string(),
            app_language: None,
            theme_mode: "system".to_string(),
        }
    }
}

pub fn load_config(state_dir: &Path) -> UiConfig {
    let config_path = state_dir.join("config.json");
    let raw = match fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return UiConfig::default(),
    };
    let mut cfg: UiConfig = serde_json::from_str(&raw).unwrap_or_default();
    cfg.application_channel = "stable".to_string();
    cfg.menu_selected_tab = cfg.menu_selected_tab.min(2);
    cfg.menu_usage_period = cfg.menu_usage_period.min(3);
    if cfg.menu_trend_metric != "requests" {
        cfg.menu_trend_metric = "tokens".to_string();
    }
    if !matches!(cfg.theme_mode.as_str(), "system" | "light" | "dark") {
        cfg.theme_mode = "system".to_string();
    }
    cfg
}

/// Atomically save `UiConfig` while preserving any external fields in `config.json`
/// (matching macOS `ConfigurationStore.save()`).
pub fn save_config(state_dir: &Path, cfg: &UiConfig) -> Result<(), String> {
    fs::create_dir_all(state_dir).map_err(|e| format!("无法创建数据目录: {}", e))?;
    let config_path = state_dir.join("config.json");

    let mut merged: Map<String, Value> = fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let mut clean = cfg.clone();
    clean.schema = 2;
    clean.application_channel = "stable".to_string();
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
    fs::write(&tmp_path, payload.as_bytes()).map_err(|e| format!("无法写入临时配置: {}", e))?;

    // Windows atomic rename with short retry on EPERM/EBUSY
    let mut last_err = None;
    for attempt in 0..5u64 {
        match fs::rename(&tmp_path, &config_path) {
            Ok(()) => {
                last_err = None;
                break;
            }
            Err(e) => {
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
