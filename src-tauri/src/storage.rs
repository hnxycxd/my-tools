//! 可移植数据目录、收藏与配置的读写与导入校验
use chrono::NaiveDateTime;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::io::{Error, ErrorKind};
use std::path::Path;
use thiserror::Error;

/// 单条收藏，与 `favorites.json` 中字段名一致
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FavoriteItem {
  pub title: String,
  pub url: String,
  /// 显示与存储格式 YYYY-MM-DD HH:mm:ss
  #[serde(rename = "addTime")]
  pub add_time: String,
}

/// 与 exe 同级的应用配置
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
  /// 例如 `Alt+Space`，与 global-shortcut 解析规则一致
  pub global_shortcut: String,
  /// 是否开机自启（与 autostart 插件实际状态尽量同步，以插件为准可再校正）
  pub autostart: bool,
}

impl Default for AppConfig {
  fn default() -> Self {
    Self {
      global_shortcut: "Alt+Space".to_string(),
      autostart: false,
    }
  }
}

/// 可移植目录：可执行文件所在目录
pub fn portable_data_dir() -> std::io::Result<std::path::PathBuf> {
  let mut p = std::env::current_exe()?;
  p.pop();
  Ok(p)
}

fn favorites_path(dir: &Path) -> std::path::PathBuf {
  dir.join("favorites.json")
}

fn app_config_path(dir: &Path) -> std::path::PathBuf {
  dir.join("app.json")
}

/// 若不存在则写入默认 `[]`
pub fn load_or_init_favorites(dir: &Path) -> std::io::Result<Vec<FavoriteItem>> {
  let p = favorites_path(dir);
  if !p.exists() {
    std::fs::write(&p, b"[]")?;
    return Ok(vec![]);
  }
  let s = std::fs::read_to_string(&p)?;
  let list: Vec<FavoriteItem> = serde_json::from_str(&s).map_err(|e| {
    Error::new(
      ErrorKind::InvalidData,
      format!("favorites.json 解析失败: {e}"),
    )
  })?;
  Ok(list)
}

/// 若不存在则写入默认配置
pub fn load_or_init_app_config(dir: &Path) -> std::io::Result<AppConfig> {
  let p = app_config_path(dir);
  if !p.exists() {
    let c = AppConfig::default();
    let s = serde_json::to_string_pretty(&c)
      .map_err(|e| Error::new(ErrorKind::InvalidData, e.to_string()))?;
    std::fs::write(&p, s)?;
    return Ok(c);
  }
  let s = std::fs::read_to_string(&p)?;
  let c: AppConfig = serde_json::from_str(&s).map_err(|e| {
    Error::new(
      ErrorKind::InvalidData,
      format!("app.json 解析失败: {e}"),
    )
  })?;
  Ok(c)
}

pub fn save_favorites_to_disk(dir: &Path, items: &[FavoriteItem]) -> std::io::Result<()> {
  let s = serde_json::to_string_pretty(items)
    .map_err(|e| Error::new(ErrorKind::InvalidData, e.to_string()))?;
  std::fs::write(favorites_path(dir), s)
}

pub fn save_app_config_to_disk(dir: &Path, c: &AppConfig) -> std::io::Result<()> {
  let s = serde_json::to_string_pretty(c)
    .map_err(|e| Error::new(ErrorKind::InvalidData, e.to_string()))?;
  std::fs::write(app_config_path(dir), s)
}

#[derive(Debug, Error)]
pub enum ImportError {
  #[error("不是 JSON 数组或格式错误: {0}")]
  NotArray(String),
  #[error("第 {0} 条: {1}")]
  Item(usize, String),
  #[error("I/O: {0}")]
  Io(#[from] std::io::Error),
  #[error("JSON: {0}")]
  Serde(#[from] serde_json::Error),
}

const TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";

fn is_valid_add_time(s: &str) -> bool {
  NaiveDateTime::parse_from_str(s, TIME_FMT).is_ok()
}

/// 导入前校验，通过后再覆盖写入
pub fn parse_and_validate_favorites_json(data: &str) -> Result<Vec<FavoriteItem>, ImportError> {
  let v: serde_json::Value = serde_json::from_str(data)?;
  let arr = v
    .as_array()
    .ok_or_else(|| ImportError::NotArray("根节点须为数组".to_string()))?;
  let url_re = Regex::new(r"^https?://").expect("static regex");
  let mut out = Vec::new();
  for (i, item) in arr.iter().enumerate() {
    let o = item
      .as_object()
      .ok_or_else(|| ImportError::Item(i + 1, "须为对象".to_string()))?;
    let title = o
      .get("title")
      .and_then(|v| v.as_str())
      .ok_or_else(|| ImportError::Item(i + 1, "缺少 title 或类型错误".to_string()))?
      .trim();
    if title.is_empty() {
      return Err(ImportError::Item(i + 1, "title 不能为空".to_string()));
    }
    let url = o
      .get("url")
      .and_then(|v| v.as_str())
      .ok_or_else(|| ImportError::Item(i + 1, "缺少 url 或类型错误".to_string()))?
      .trim();
    if !url_re.is_match(url) {
      return Err(ImportError::Item(
        i + 1,
        "url 须以 http:// 或 https:// 开头".to_string(),
      ));
    }
    let add_time = o
      .get("addTime")
      .and_then(|v| v.as_str())
      .ok_or_else(|| ImportError::Item(i + 1, "缺少 addTime 或类型错误".to_string()))?
      .trim();
    if !is_valid_add_time(add_time) {
      return Err(ImportError::Item(
        i + 1,
        format!("addTime 须为 {TIME_FMT}"),
      ));
    }
    out.push(FavoriteItem {
      title: title.to_string(),
      url: url.to_string(),
      add_time: add_time.to_string(),
    });
  }
  Ok(out)
}
