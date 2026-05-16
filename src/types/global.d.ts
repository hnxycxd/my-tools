import type { MessageInstance } from "antd/es/message/interface";

/** 在 Antd App 中挂载，便于不直接 import message */
declare global {
  interface Window {
    messageApi?: MessageInstance;
    /** Tauri 2 在 WebView 中注入；普通浏览器无此字段 */
    __TAURI_INTERNALS__?: unknown;
  }
}

export {};
