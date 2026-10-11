/** 与 Rust `ShortcutItem` / shortcuts.json 字段一致：本地文件夹或文件的快捷入口 */
export type ShortcutItem = {
  /** 用户自定义名称，搜索条按它（含拼音）匹配 */
  name: string;
  /** 本地文件夹或文件的绝对路径 */
  path: string;
  addTime: string;
};
