import type { AppConfig, FavoriteItem } from '../types/favorite'

/**
 * 浏览器直连 Vite 预览时的示例数据：Tauri WebView 内不会使用，
 * 仅便于 `npm run dev` 时在浏览器里查看/调整界面。
 */
export const PREVIEW_FAVORITES: FavoriteItem[] = [
  { title: 'GitHub', url: 'https://github.com', addTime: '2026-09-10 09:12:00' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/zh-CN/', addTime: '2026-09-09 20:45:00' },
  { title: '哔哩哔哩', url: 'https://www.bilibili.com', addTime: '2026-09-08 21:03:00' },
  { title: 'React 中文文档', url: 'https://zh-hans.react.dev', addTime: '2026-09-05 14:30:00' },
  { title: 'Tailwind CSS', url: 'https://tailwindcss.com/docs', addTime: '2026-09-02 11:20:00' },
  { title: 'Vite', url: 'https://cn.vite.dev', addTime: '2026-08-28 16:08:00' },
  { title: '掘金', url: 'https://juejin.cn', addTime: '2026-08-20 10:00:00' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com', addTime: '2026-08-11 22:41:00' },
]

export const PREVIEW_CONFIG: AppConfig = {
  global_shortcut: 'Alt+Space',
  autostart: false,
}
