import type { AppEntry } from '../types/app'
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

export const PREVIEW_APPS: AppEntry[] = [
  { name: '记事本', target: 'C:\\Windows\\System32\\notepad.exe' },
  { name: '计算器', target: 'C:\\Windows\\System32\\calc.exe' },
  { name: 'Visual Studio Code', target: 'C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' },
]

/** 浏览器预览用的示例应用图标（玉色圆角方块 PNG）；真实图标在 Tauri 内由 Rust 提取 */
const SAMPLE_APP_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAA/UlEQVR42u3asQ2DMBAFUKahySJXeICs4BWo2IIq3fWMwQBXsQA7UDmxdJYiFAIV4lu/uAYk/J+wZcnnRkybP9WKaRDTKKbd51l/UXU+ZvAMuxn3Xjz8Ay8xncR0EdNVTNNFtfqYk2eInukUIKsHMZ0vDHxUs2cKR4CnmI43Cr6t0TP+BISbh/9GhC3g4b8ogdRQ1kQBxJvN+TNrIhZA6ys9gVXO3Ja5PwECcuZQps8CCMiZY+O73goIyJm7xrfuBFo9AQQQQAABBBBAAAEEEEAAAQQQQAABBMAC4I8W4Q934Y/X4Rsc8C2mKpp88G3WKhrdVVw1qOKyB9R1mzdSceqqb7+2mAAAAABJRU5ErkJggg=='

export const PREVIEW_APP_ICONS: Record<string, string> = Object.fromEntries(
  PREVIEW_APPS.map((a) => [a.target, SAMPLE_APP_ICON]),
)
