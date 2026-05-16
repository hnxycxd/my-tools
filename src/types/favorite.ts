/** 与 Rust `FavoriteItem` / favorites.json 字段一致 */
export type FavoriteItem = {
  title: string;
  url: string;
  addTime: string;
};

export type AppConfig = {
  global_shortcut: string;
  autostart: boolean;
};
