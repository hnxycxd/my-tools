import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriWebview } from "./tauriEnv";

/** 允许通过浏览器调试的窗口标识 */
const BROWSER_DEV_LABELS = ["palette", "admin"] as const;
type BrowserDevLabel = (typeof BROWSER_DEV_LABELS)[number];

/**
 * 解析当前要渲染的 Tauri 窗口 label。
 * - 在 Tauri 内：与真实 WebView 窗口 label 一致。
 * - 在普通浏览器：使用 URL 参数 `?view=admin` 或 `?view=palette`，缺省为 `palette`（便于纯前端联调）。
 */
export function resolveTauriWindowLabel(): string {
  if (isTauriWebview()) {
    return getCurrentWindow().label;
  }

  const fromQuery = new URLSearchParams(window.location.search).get("view");
  if (fromQuery && BROWSER_DEV_LABELS.includes(fromQuery as BrowserDevLabel)) {
    return fromQuery;
  }

  // 缺省用 palette，与多数调试场景（快开浮层）一致
  return "palette";
}
