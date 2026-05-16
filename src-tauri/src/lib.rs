mod storage;

use std::sync::Mutex;

const PACKAGE_JSON: &str = include_str!("../../package.json");

#[derive(serde::Serialize)]
struct AboutInfo {
  name: String,
  version: String,
  author: String,
}

use storage::{
  load_or_init_app_config, load_or_init_favorites, parse_and_validate_favorites_json,
  save_app_config_to_disk, save_favorites_to_disk, AppConfig, FavoriteItem,
};
use tauri::Emitter;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;
use tauri::Runtime;
use tauri::WebviewWindow;
use tauri::WindowEvent;
use tauri::Wry;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const WIN_PALETTE: &str = "palette";
const WIN_ADMIN: &str = "admin";

/// 持有一段 [`TrayIcon`] 引用，避免被 drop 后托盘消失
struct TrayState(#[allow(dead_code)] tauri::tray::TrayIcon);

/// 进程内收藏快照：仅启动时从磁盘加载；管理端写盘后不更新本快照，需 /reload
pub struct FavoritesState(Mutex<Vec<FavoriteItem>>);

/// 可移植数据目录
pub struct AppDirState {
  dir: Mutex<std::path::PathBuf>,
}

fn data_dir_from_state(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let st = app
    .try_state::<AppDirState>()
    .ok_or_else(|| "状态未初始化".to_string())?;
  st.dir
    .lock()
    .map_err(|e| e.to_string())
    .map(|p| p.clone())
}

/// 速开窗口：固定约 800×560 的紧凑区域，水平居中、靠工作区上约 40% 处，不占满屏以便用户操作其它窗口
fn position_palette_window<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
  use tauri::{PhysicalPosition, PhysicalSize};

  const TARGET_W: u32 = 800;
  const TARGET_H: u32 = 560;

  let place = |wa: &tauri::PhysicalRect<i32, u32>| -> tauri::Result<()> {
    let work_w = wa.size.width;
    let work_h = wa.size.height;
    let w = TARGET_W.min(work_w);
    let h = TARGET_H.min(work_h.saturating_sub(48)).max(200);
    let x = wa.position.x + ((work_w.saturating_sub(w)) / 2) as i32;
    let y_from_top = wa.position.y + (work_h as i32 * 25 / 100);
    let y_max = wa.position.y + (work_h.saturating_sub(h) as i32);
    let y = y_from_top.min(y_max);
    let _ = window.set_size(tauri::Size::Physical(PhysicalSize::new(w, h)));
    let _ = window.set_position(tauri::Position::Physical(PhysicalPosition::new(x, y)));
    Ok(())
  };

  if let Some(pm) = window.primary_monitor()? {
    place(pm.work_area())?;
  } else if let Some(cm) = window.current_monitor()? {
    place(cm.work_area())?;
  }
  Ok(())
}

fn show_palette<R: Runtime, M: Manager<R>>(app: &M) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(WIN_PALETTE) {
    position_palette_window(&w).map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
  }
  Ok(())
}

fn hide_palette<R: Runtime, M: Manager<R>>(app: &M) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(WIN_PALETTE) {
    w.hide().map_err(|e| e.to_string())?;
  }
  Ok(())
}

fn show_admin<R: Runtime, M: Manager<R>>(app: &M) -> Result<(), String> {
  let _ = hide_palette(app);
  if let Some(w) = app.get_webview_window(WIN_ADMIN) {
    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// 重新注册全局快捷键：先清空本进程已登记的快捷键，再绑定配置中的组合键。
/// 若组合键已被其它进程占用（如 PowerToys Run 默认 Alt+Space），`on_shortcut` 会失败，由调用方决定是报错还是降级启动。
fn apply_shortcut(app: &tauri::AppHandle, hotkey: &str) -> Result<(), String> {
  let gs = app.global_shortcut();
  // 插件在 unregister_all 内部会先 take 掉 HashMap；若 OS 侧 unregister 失败可能留下不一致状态，至少打出日志便于排查
  if let Err(e) = gs.unregister_all() {
    eprintln!("global_shortcut: unregister_all 时出现警告: {}", e);
  }
  gs.on_shortcut(hotkey, move |a, _sh, e| {
    if e.state == ShortcutState::Pressed {
      let _ = show_palette(a);
    }
  })
  .map_err(|e| e.to_string())?;
  Ok(())
}

fn sync_autostart_with_config(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
  let al = app.autolaunch();
  if want {
    al.enable().map_err(|e| e.to_string())?;
  } else {
    // Windows：从未写入过 Run 项时 delete_value 会报 os error 2（文件不存在），与是否改快捷键无关
    let was_on = al.is_enabled().unwrap_or(false);
    if was_on {
      al.disable().map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

fn build_tray_menu(app: &tauri::AppHandle) -> Result<Menu<Wry>, String> {
  let autostart_checked = app.autolaunch().is_enabled().unwrap_or(false);
  let open_i = MenuItem::with_id(app, "open", "打开", true, None::<&str>).map_err(|e| e.to_string())?;
  let admin_i = MenuItem::with_id(app, "admin", "管理", true, None::<&str>).map_err(|e| e.to_string())?;
  let auto_i = CheckMenuItem::with_id(
    app,
    "autostart",
    "开机启动",
    true,
    autostart_checked,
    None::<&str>,
  )
  .map_err(|e| e.to_string())?;
  let restart_i = MenuItem::with_id(app, "restart", "重启", true, None::<&str>).map_err(|e| e.to_string())?;
  let about_i = MenuItem::with_id(app, "about", "关于", true, None::<&str>).map_err(|e| e.to_string())?;
  let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;
  let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
  let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
  Menu::with_items(app, &[&open_i, &admin_i, &auto_i, &sep1, &restart_i, &about_i, &sep2, &quit_i])
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_favorites_snapshot(state: tauri::State<'_, FavoritesState>) -> Result<Vec<FavoriteItem>, String> {
  let g = state.0.lock().map_err(|e| e.to_string())?;
  Ok(g.clone())
}

/// 管理页用：从磁盘重读，避免「导入写盘」后仍只显示进程内快照
#[tauri::command]
fn get_favorites_from_disk(app: tauri::AppHandle) -> Result<Vec<FavoriteItem>, String> {
  let dir = data_dir_from_state(&app)?;
  load_or_init_favorites(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_app_config_cmd(app: tauri::AppHandle) -> Result<AppConfig, String> {
  let dir = data_dir_from_state(&app)?;
  load_or_init_app_config(&dir).map_err(|e| e.to_string())
}

/// 只写磁盘，不更新 FavoritesState
#[tauri::command]
fn save_favorites_replace(app: tauri::AppHandle, items: Vec<FavoriteItem>) -> Result<(), String> {
  let dir = data_dir_from_state(&app)?;
  save_favorites_to_disk(&dir, &items).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_app_config_cmd(app: tauri::AppHandle, cfg: AppConfig) -> Result<(), String> {
  let dir = data_dir_from_state(&app)?;
  save_app_config_to_disk(&dir, &cfg).map_err(|e| e.to_string())?;
  sync_autostart_with_config(&app, cfg.autostart)?;
  apply_shortcut(&app, &cfg.global_shortcut)?;
  Ok(())
}

#[tauri::command]
fn import_favorites_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let dir = data_dir_from_state(&app)?;
  let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
  let items = parse_and_validate_favorites_json(&data).map_err(|e| e.to_string())?;
  save_favorites_to_disk(&dir, &items).map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
fn export_favorites_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let dir = data_dir_from_state(&app)?;
  let items = load_or_init_favorites(&dir).map_err(|e| e.to_string())?;
  let s = serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?;
  std::fs::write(&path, s).map_err(|e| e.to_string())?;
  Ok(())
}

/// 在系统默认浏览器中打开 URL；Windows 用 `url.dll,FileProtocolHandler` 替代 detached 打开，便于浏览器窗口拿到前台
#[tauri::command]
async fn open_url_in_system_browser(
  #[allow(unused_variables)] app: tauri::AppHandle,
  url: String,
) -> Result<(), String> {
  if !url.starts_with("http://") && !url.starts_with("https://") {
    return Err("仅支持 http(s) 链接".into());
  }
  #[cfg(target_os = "windows")]
  {
    use std::process::Command;
    Command::new("rundll32")
      .arg("url.dll,FileProtocolHandler")
      .arg(&url)
      .spawn()
      .map_err(|e| e.to_string())?;
    return Ok(());
  }
  #[cfg(not(target_os = "windows"))]
  {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(())
  }
}

/// 从磁盘读取 `app.json` 中的快捷键并重新注册（录入取消或失败时恢复，避免长时间无全局热键）
#[tauri::command]
fn reapply_global_shortcut_from_config(app: tauri::AppHandle) -> Result<(), String> {
  let dir = data_dir_from_state(&app)?;
  let cfg = load_or_init_app_config(&dir).map_err(|e| e.to_string())?;
  apply_shortcut(&app, &cfg.global_shortcut)
}

/// 录入 Alt+Space 时：Windows 常把该组合交给窗口系统菜单，WebView 的 JS 收不到。
/// 因此在 Rust 侧用 global-shortkey 注册临时监听，在 OS 层捕获后向管理窗派发 `shortcut-recording-result`。
#[tauri::command]
fn start_hotkey_recording_probe(app: tauri::AppHandle) -> Result<(), String> {
  let gs = app.global_shortcut();
  if let Err(e) = gs.unregister_all() {
    eprintln!("global_shortcut: unregister_all (recording probe): {}", e);
  }
  gs.on_shortcut("Alt+Space", move |handle, _shortcut, e| {
    if e.state != ShortcutState::Pressed {
      return;
    }
    let payload = "Alt+Space";
    if let Err(err) = handle.emit_to(WIN_ADMIN, "shortcut-recording-result", payload) {
      eprintln!("emit shortcut-recording-result: {}", err);
    }
  })
  .map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
  app.restart();
}

#[tauri::command]
fn get_about_info() -> Result<AboutInfo, String> {
  eprintln!("[about] PACKAGE_JSON len={}", PACKAGE_JSON.len());
  eprintln!("[about] PACKAGE_JSON head={}", &PACKAGE_JSON[..200.min(PACKAGE_JSON.len())]);
  let val: serde_json::Value = serde_json::from_str(PACKAGE_JSON).map_err(|e| e.to_string())?;
  eprintln!("[about] parsed: name={:?}, version={:?}, author={:?}",
    val.get("name"), val.get("version"), val.get("author"));
  let name = val["name"].as_str().unwrap_or("c-tools").to_string();
  let version = val["version"].as_str().unwrap_or("0.0.0").to_string();
  let author = val["author"].as_str().unwrap_or("").to_string();
  eprintln!("[about] returning: name={}, version={}, author={}", name, version, author);
  Ok(AboutInfo { name, version, author })
}

#[tauri::command]
fn get_data_dir_for_ui(app: tauri::AppHandle) -> Result<String, String> {
  let dir = data_dir_from_state(&app)?;
  Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn show_palette_cmd(app: tauri::AppHandle) -> Result<(), String> {
  show_palette(&app)
}

#[tauri::command]
fn hide_palette_cmd(app: tauri::AppHandle) -> Result<(), String> {
  hide_palette(&app)
}

#[tauri::command]
fn show_admin_cmd(app: tauri::AppHandle) -> Result<(), String> {
  show_admin(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(
      tauri_plugin_autostart::Builder::new()
        .app_name("c-tools")
        .build(),
    )
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      let dir = storage::portable_data_dir().map_err(|e| e.to_string())?;
      app.manage(AppDirState {
        dir: Mutex::new(dir.clone()),
      });

      let favorites = load_or_init_favorites(&dir).map_err(|e| e.to_string())?;
      app.manage(FavoritesState(Mutex::new(favorites)));

      let cfg = load_or_init_app_config(&dir).map_err(|e| e.to_string())?;
      let _ = sync_autostart_with_config(&app.handle(), cfg.autostart);

      // 热键被占用时不阻塞整个应用（常见于 Alt+Space 与 PowerToys 冲突、或上一进程未退出）
      if let Err(e) = apply_shortcut(&app.handle(), &cfg.global_shortcut) {
        eprintln!(
          "全局快捷键「{}」注册失败: {}。可通过托盘菜单打开调色板，或在设置中更换快捷键。",
          cfg.global_shortcut, e
        );
      }

      let app_h = app.handle().clone();
      let icon: Image = app
        .default_window_icon()
        .ok_or("缺少 app 窗口图标，请在 tauri 配置中配置 icons 目录")?
        .clone();
      let menu = build_tray_menu(app.handle())?;
      let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |h, e| {
          // muda::MenuId：通过 AsRef<str> 取字符串，便于与菜单项 with_id 一致比较
          let id: &str = e.id.as_ref();
          if id == "open" {
            let _ = show_palette(h);
          } else if id == "admin" {
            let _ = show_admin(h);
          } else if id == "autostart" {
            let want = !h.autolaunch().is_enabled().unwrap_or(false);
            if let Some(st) = h.try_state::<AppDirState>() {
              if let Ok(dir) = st.dir.lock() {
                if let Ok(mut c) = load_or_init_app_config(&*dir) {
                  c.autostart = want;
                  let _ = save_app_config_to_disk(&*dir, &c);
                }
              }
            }
            let _ = sync_autostart_with_config(h, want);
          } else if id == "restart" {
            let _ = h.restart();
          } else if id == "about" {
            if let Some(w) = h.get_webview_window("about") {
              let _ = w.show();
              let _ = w.set_focus();
            }
          } else if id == "quit" {
            h.exit(0);
          }
        })
        .build(&app_h)
        .map_err(|e| e.to_string())?;
      app.manage(TrayState(tray));

      if let Some(w) = app.get_webview_window(WIN_PALETTE) {
        let _ = w.hide();
      }
      if let Some(w) = app.get_webview_window(WIN_ADMIN) {
        let _ = w.hide();
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_favorites_snapshot,
      get_favorites_from_disk,
      get_app_config_cmd,
      save_favorites_replace,
      save_app_config_cmd,
      import_favorites_path,
      export_favorites_path,
      open_url_in_system_browser,
      reapply_global_shortcut_from_config,
      start_hotkey_recording_probe,
      relaunch_app,
      get_about_info,
      get_data_dir_for_ui,
      show_palette_cmd,
      hide_palette_cmd,
      show_admin_cmd,
    ])
    // 管理窗和关于窗点右上角关闭会销毁 Webview，导致后续无法再打开；改为仅隐藏保留实例
    .on_window_event(|window, event| {
      let label = window.label();
      if label != WIN_ADMIN && label != "about" {
        return;
      }
      let WindowEvent::CloseRequested { api, .. } = event else {
        return;
      };
      let _ = window.hide();
      api.prevent_close();
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
