/**
 * 是否为 Tauri WebView：仅此时存在 `window.__TAURI_INTERNALS__`，`invoke` / `getCurrentWindow` 才可用。
 */
export function isTauriWebview(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ != null;
}
