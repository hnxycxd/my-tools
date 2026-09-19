//! 本机应用：扫描「开始菜单」快捷方式，供速开窗搜索并直接启动。
//! 仅保留目标为本地可执行程序的快捷方式（过滤指向网址/文档的条目）；
//! 并用 Shell API 提取目标程序图标，转成 PNG data URI 供前端展示。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppEntry {
  /// 显示名（快捷方式文件名去扩展名）
  pub name: String,
  /// 快捷方式完整路径；启动时交给 explorer 解析执行
  pub target: String,
}

/// 名称含这些关键字的多为卸载器，不作为可启动应用
#[cfg(target_os = "windows")]
const NAME_BLOCKLIST: [&str; 2] = ["卸载", "uninstall"];

/// 快捷方式目标需命中这些扩展名才算本机应用（排除指向网址、文档、帮助文件的条目）
#[cfg(target_os = "windows")]
const TARGET_EXEC_EXTS: [&str; 4] = ["exe", "bat", "cmd", "msc"];

/// 递归收集目录下的 .lnk 文件
#[cfg(target_os = "windows")]
fn collect_lnk_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
  let Ok(rd) = std::fs::read_dir(dir) else {
    return;
  };
  for entry in rd.flatten() {
    let p = entry.path();
    if p.is_dir() {
      collect_lnk_files(&p, out);
    } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
      out.push(p);
    }
  }
}

/// 线程上 COM 初始化标记：Drop 时配对 CoUninitialize
#[cfg(target_os = "windows")]
struct CoGuard(bool);

#[cfg(target_os = "windows")]
impl Drop for CoGuard {
  fn drop(&mut self) {
    use windows::Win32::System::Com::CoUninitialize;
    if self.0 {
      unsafe { CoUninitialize() };
    }
  }
}

/// 当前线程初始化 COM（已是 MTA 时直接复用）；失败返回 None
#[cfg(target_os = "windows")]
fn com_init() -> Option<CoGuard> {
  use windows::Win32::System::Com::{
    CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
  };
  use windows::Win32::Foundation::RPC_E_CHANGED_MODE;

  let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
  if hr.is_err() && hr != RPC_E_CHANGED_MODE {
    return None;
  }
  Some(CoGuard(hr.is_ok()))
}

/// 解析 .lnk 的目标路径并展开环境变量；目标不是本地可执行程序（网址/文档/命名空间项）时返回 None
#[cfg(target_os = "windows")]
fn resolve_lnk_target(
  shell_link: &windows::Win32::UI::Shell::IShellLinkW,
  persist: &windows::Win32::System::Com::IPersistFile,
  lnk_path: &str,
) -> Option<String> {
  use windows::core::PCWSTR;
  use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
  use windows::Win32::System::Com::STGM_READ;
  use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
  use windows::Win32::UI::Shell::SLGP_RAWPATH;

  let wide: Vec<u16> = lnk_path.encode_utf16().chain(std::iter::once(0)).collect();
  unsafe { persist.Load(PCWSTR::from_raw(wide.as_ptr()), STGM_READ) }.ok()?;
  let mut buf = [0u16; 1024];
  let mut wfd = WIN32_FIND_DATAW::default();
  unsafe { shell_link.GetPath(&mut buf, &mut wfd, SLGP_RAWPATH.0 as u32) }.ok()?;
  let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
  if len == 0 {
    return None;
  }
  let mut path = String::from_utf16_lossy(&buf[..len]);
  if path.contains('%') {
    // SLGP_RAWPATH 保留未展开的环境变量，如 %SystemRoot%\System32\...
    let src: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut dst = [0u16; 1024];
    let n = unsafe { ExpandEnvironmentStringsW(PCWSTR::from_raw(src.as_ptr()), Some(&mut dst)) };
    if n > 0 && (n as usize) <= dst.len() {
      let end = dst.iter().position(|&c| c == 0).unwrap_or(n as usize);
      path = String::from_utf16_lossy(&dst[..end]);
    }
  }
  let ext = std::path::Path::new(&path)
    .extension()
    .and_then(|e| e.to_str())
    .map(|e| e.to_ascii_lowercase())?;
  TARGET_EXEC_EXTS
    .iter()
    .any(|e| *e == ext)
    .then_some(path)
}

/// 扫描所有用户与当前用户的开始菜单；目标为本地可执行程序的快捷方式按名称去重后返回。
/// 仅覆盖 Win32 桌面应用，UWP/商店应用不在其中。
pub fn scan_installed_apps() -> Vec<AppEntry> {
  #[cfg(not(target_os = "windows"))]
  {
    Vec::new()
  }

  #[cfg(target_os = "windows")]
  {
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, IPersistFile};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let _com = match com_init() {
      Some(g) => g,
      None => return Vec::new(),
    };
    // 整个扫描复用同一个 ShellLink 实例，逐个 Load 目标文件
    let Ok(shell_link) = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
      .map(|sl: IShellLinkW| sl)
    else {
      return Vec::new();
    };
    let Ok(persist) = shell_link.cast::<IPersistFile>() else {
      return Vec::new();
    };

    let mut roots = Vec::new();
    if let Ok(pd) = std::env::var("ProgramData") {
      roots.push(std::path::PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(ad) = std::env::var("APPDATA") {
      roots.push(std::path::PathBuf::from(ad).join(r"Microsoft\Windows\Start Menu\Programs"));
    }

    let mut lnks = Vec::new();
    for root in &roots {
      collect_lnk_files(root, &mut lnks);
    }

    let mut seen = std::collections::HashSet::new();
    let mut apps = Vec::new();
    for p in lnks {
      let Some(name) = p.file_stem().and_then(|s| s.to_str()) else {
        continue;
      };
      let lower = name.to_lowercase();
      if NAME_BLOCKLIST.iter().any(|h| lower.contains(h)) {
        continue;
      }
      let Some(_resolved) = resolve_lnk_target(&shell_link, &persist, &p.to_string_lossy()) else {
        continue;
      };
      if !seen.insert(lower) {
        continue;
      }
      apps.push(AppEntry {
        name: name.to_string(),
        target: p.to_string_lossy().into_owned(),
      });
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
  }
}

/// 提取快捷方式目标程序的图标，返回 PNG data URI；任意一步失败返回 None（前端回退首字母印章）。
#[cfg(target_os = "windows")]
pub fn extract_icon_data_uri(target: &str) -> Option<String> {
  use base64::Engine as _;
  use windows::core::PCWSTR;
  use windows::Win32::Foundation::SIZE;
  use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
  };
  use windows::Win32::UI::Shell::{
    SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
  };

  // 图标提取在阻塞线程池执行，线程可能未初始化 COM；已是 MTA 时直接复用
  let _com = com_init()?;

  let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
  // SIIGBF_ICONONLY：只取图标不出缩略图；BIGGERSIZEOK：允许返回更大的原生尺寸避免放大发糊
  let factory: IShellItemImageFactory =
    unsafe { SHCreateItemFromParsingName(PCWSTR::from_raw(wide.as_ptr()), None) }.ok()?;
  let hbmp = unsafe { factory.GetImage(SIZE { cx: 64, cy: 64 }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK) }.ok()?;

  let mut bm = BITMAP::default();
  let got = unsafe {
    GetObjectW(
      hbmp.into(),
      std::mem::size_of::<BITMAP>() as i32,
      Some(&mut bm as *mut BITMAP as *mut _),
    )
  };
  if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
    let _ = unsafe { DeleteObject(hbmp.into()) };
    return None;
  }
  let (w, h) = (bm.bmWidth, bm.bmHeight);

  // 统一转成自顶向下的 32bpp BGRA
  let hdc = unsafe { GetDC(None) };
  let mut bi = BITMAPINFO::default();
  bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
  bi.bmiHeader.biWidth = w;
  bi.bmiHeader.biHeight = -h;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB.0;
  let mut buf = vec![0u8; (w * h * 4) as usize];
  let lines = unsafe {
    GetDIBits(
      hdc,
      hbmp,
      0,
      h as u32,
      Some(buf.as_mut_ptr() as *mut _),
      &mut bi,
      DIB_RGB_COLORS,
    )
  };
  let _ = unsafe { ReleaseDC(None, hdc) };
  let _ = unsafe { DeleteObject(hbmp.into()) };
  if lines != h {
    return None;
  }

  // Shell 返回的是预乘 alpha 的 BGRA；转成直通 alpha 的 RGBA 供 PNG 编码
  for px in buf.chunks_exact_mut(4) {
    let a = px[3] as u32;
    if a == 0 {
      px[0] = 0;
      px[1] = 0;
      px[2] = 0;
      continue;
    }
    let (b, g, r) = (px[0] as u32, px[1] as u32, px[2] as u32);
    px[0] = ((r * 255 + a / 2) / a).min(255) as u8;
    px[1] = ((g * 255 + a / 2) / a).min(255) as u8;
    px[2] = ((b * 255 + a / 2) / a).min(255) as u8;
  }

  let img = image::RgbaImage::from_raw(w as u32, h as u32, buf)?;
  let mut png = Vec::new();
  img
    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
    .ok()?;
  Some(format!(
    "data:image/png;base64,{}",
    base64::engine::general_purpose::STANDARD.encode(png)
  ))
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
  use super::{extract_icon_data_uri, scan_installed_apps};

  #[test]
  fn scans_start_menu_apps() {
    let apps = scan_installed_apps();
    assert!(!apps.is_empty(), "开始菜单应能扫到至少一个应用");
    for a in &apps {
      assert!(!a.name.is_empty());
      assert!(a.target.to_lowercase().ends_with(".lnk"), "target 应为 .lnk 路径");
    }
  }

  #[test]
  fn scanned_apps_resolve_to_local_executables() {
    // 扫描阶段已过滤「目标不是本地可执行程序」的快捷方式（如 SDK 文档链接），
    // 因此任一扫描结果都应能解析出命中 TARGET_EXEC_EXTS 的目标路径
    use super::{com_init, resolve_lnk_target};
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, IPersistFile};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    let apps = scan_installed_apps();
    let first = apps.first().expect("应有至少一个应用").target.clone();
    let _com = com_init().expect("COM 初始化失败");
    let shell_link: IShellLinkW =
      unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.expect("创建 ShellLink 失败");
    let persist = shell_link.cast::<IPersistFile>().expect("cast 失败");
    let resolved = resolve_lnk_target(&shell_link, &persist, &first).expect("扫描结果应能解析出目标");
    let ext = std::path::Path::new(&resolved)
      .extension()
      .and_then(|e| e.to_str())
      .unwrap_or("")
      .to_ascii_lowercase();
    assert!(
      ["exe", "bat", "cmd", "msc"].contains(&ext.as_str()),
      "解析目标应为可执行程序，实际: {resolved}"
    );
  }

  #[test]
  fn extracts_icon_for_scanned_app() {
    let apps = scan_installed_apps();
    let first = apps.first().map(|a| a.target.clone()).expect("应有至少一个应用");
    let uri = extract_icon_data_uri(&first).expect("应能提取图标");
    assert!(uri.starts_with("data:image/png;base64,"));
    // PNG 头与 data URI 载荷合理性
    assert!(uri.len() > 100);
  }
}
