import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isEnabled } from "@tauri-apps/plugin-autostart";
import { App, ConfigProvider, Modal, theme } from "antd";
import {
  Bookmark,
  Clock,
  Download,
  Edit2,
  ExternalLink,
  Github,
  HelpCircle,
  Info,
  Keyboard,
  Plus,
  Power,
  Search,
  Settings as SettingsIcon,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, FavoriteItem } from "../types/favorite";
import { isTauriWebview } from "../utils/tauriEnv";
import pkg from "../../package.json";

/** 管理页分区：与 Figma Make 侧栏一致 */
type AdminSection = "general" | "bookmarks";

/**
 * 侧栏与按钮展示用：将磁盘中的 `Alt+Space` 转为更易读的 `Alt + Space`
 */
function formatShortcutLabel(raw: string): string {
  const t = raw.trim();
  if (!t) {
    return "例如 Alt + Space";
  }
  return t.split("+").join(" + ");
}

/**
 * 从 keydown 解析 global-hotkey 字符串（与 `app.json` / global-hotkey 的 Code 命名一致，如 Alt+Space、Ctrl+Shift+KeyA）
 * @returns 合法组合键；`null` 表示用户按 Esc 取消；`""` 表示仅修饰键、忽略本次 keydown
 */
function parseHotkeyFromKeydown(e: KeyboardEvent): string | null | "" {
  if (e.key === "Escape") {
    return null;
  }
  if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") {
    return "";
  }
  const mods: string[] = [];
  if (e.ctrlKey) {
    mods.push("Ctrl");
  }
  if (e.altKey) {
    mods.push("Alt");
  }
  if (e.shiftKey) {
    mods.push("Shift");
  }
  if (e.metaKey) {
    mods.push("Super");
  }
  if (mods.length === 0) {
    return "__INVALID_NO_MODIFIER__";
  }
  const main = e.code;
  if (!main) {
    return "__INVALID_NO_MODIFIER__";
  }
  return [...mods, main].join("+");
}

/**
 * 管理页：侧栏 + 常规设置 / 书签管理；逻辑与原先一致，仅样式与交互对齐设计稿
 */
export function AdminView() {
  const { message: messageFromHook } = App.useApp();
  useEffect(() => {
    if (!window.messageApi) {
      window.messageApi = messageFromHook;
    }
  }, [messageFromHook]);

  const [dataDir, setDataDir] = useState<string>("");
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [q, setQ] = useState("");

  const [draftTitle, setDraftTitle] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  /** 正在编辑的原记录（以 addTime+title+url 定位） */
  const [editing, setEditing] = useState<FavoriteItem | null>(null);
  /** 书签添加/编辑弹层 */
  const [bookmarkModalOpen, setBookmarkModalOpen] = useState(false);
  /** 当前侧栏选中的分区 */
  const [section, setSection] = useState<AdminSection>("general");
  /** 是否正在录入全局快捷键（Figma 式按键捕获） */
  const [shortcutRecording, setShortcutRecording] = useState(false);
  /** 录入开始时由 Rust 注销并挂起探针；取消/切页须从磁盘恢复注册，否则会长时间无热键 */
  const hotkeysReleasedForRecordingRef = useRef(false);
  /** 与 shortcutRecording 同步，供 Tauri 事件回调判断是否在录入态 */
  const shortcutRecordingRef = useRef(false);
  /** 防止 JS 与 Native 探针对同一组合重复提交 */
  const shortcutCommitLockRef = useRef(false);

  const load = useCallback(async () => {
    if (!isTauriWebview()) {
      return;
    }
    const path = await invoke<string>("get_data_dir_for_ui");
    setDataDir(path);
    const list = await invoke<FavoriteItem[]>("get_favorites_from_disk");
    const c = await invoke<AppConfig>("get_app_config_cmd");
    setFavorites([...list].sort(compareFav));
    setConfig(c);
    const b = await isEnabled().catch(() => false);
    if (b !== c.autostart) {
      setConfig({ ...c, autostart: b });
    }
  }, []);

  useEffect(() => {
    if (!isTauriWebview()) {
      return;
    }
    void load();
  }, [load]);

  /** 从磁盘恢复全局热键（录入取消、切走页面、保存失败时使用） */
  const restoreGlobalShortcutIfNeeded = useCallback(async () => {
    if (!hotkeysReleasedForRecordingRef.current) {
      return;
    }
    hotkeysReleasedForRecordingRef.current = false;
    try {
      await invoke("reapply_global_shortcut_from_config");
    } catch (e) {
      console.error(e);
      (window.messageApi ?? messageFromHook).error(`恢复快捷键失败：${String(e)}`);
    }
  }, [messageFromHook]);

  /** 开始录入：Rust 注销原热键并挂 Alt+Space 的 OS 层探针（WebView 收不到该组合）；其它组合仍由页面 keydown 解析 */
  const beginShortcutRecording = useCallback(async () => {
    try {
      await invoke("start_hotkey_recording_probe");
      hotkeysReleasedForRecordingRef.current = true;
    } catch (e) {
      console.error(e);
      (window.messageApi ?? messageFromHook).error(
        `无法开始录入：${String(e)}（若与其它软件热键冲突，可先关闭冲突项或使用下方「一键设为 Alt + Space」）`,
      );
      return;
    }
    setShortcutRecording(true);
    (window.messageApi ?? messageFromHook).info("请按下想要设置的组合键…");
  }, [messageFromHook]);

  /** 取消录入并尽量恢复热键 */
  const endShortcutRecordingCancelled = useCallback(async () => {
    setShortcutRecording(false);
    await restoreGlobalShortcutIfNeeded();
  }, [restoreGlobalShortcutIfNeeded]);

  /** 离开常规设置时结束录入并恢复热键 */
  useEffect(() => {
    if (section !== "general") {
      void endShortcutRecordingCancelled();
    }
  }, [section, endShortcutRecordingCancelled]);

  /** 标题或 URL 匹配；标题命中的行排在仅 URL 命中的行之前，组内仍按添加时间等 compareFav 排序 */
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) {
      return favorites;
    }
    const titleHits: FavoriteItem[] = [];
    const urlOnly: FavoriteItem[] = [];
    for (const f of favorites) {
      const titleOk = f.title.toLowerCase().includes(t);
      const urlOk = f.url.toLowerCase().includes(t);
      if (titleOk) {
        titleHits.push(f);
      } else if (urlOk) {
        urlOnly.push(f);
      }
    }
    titleHits.sort(compareFav);
    urlOnly.sort(compareFav);
    return [...titleHits, ...urlOnly];
  }, [favorites, q]);

  const persistAll = useCallback(
    (next: FavoriteItem[], okMsg: string) => {
      void (async () => {
        try {
          await invoke("save_favorites_replace", { items: next });
          setFavorites([...next].sort(compareFav));
          (window.messageApi ?? messageFromHook).success(okMsg);
        } catch (e) {
          console.error(e);
          (window.messageApi ?? messageFromHook).error(String(e));
        }
      })();
    },
    [messageFromHook],
  );

  const onDelete = (f: FavoriteItem) => {
    const k = makeRowKey(f);
    const next = favorites.filter((x) => makeRowKey(x) !== k);
    persistAll(next, "已保存（速开需 /reload 后生效）");
  };

  const closeBookmarkModal = () => {
    setBookmarkModalOpen(false);
    setEditing(null);
    setDraftTitle("");
    setDraftUrl("");
  };

  /** 提交书签表单：新增或编辑，校验规则与原先一致 */
  const submitBookmarkRow = () => {
    const title = draftTitle.trim();
    const url = draftUrl.trim();
    const messageApi = window.messageApi ?? messageFromHook;
    if (title.length === 0) {
      messageApi.warning("请填写标题");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      messageApi.warning("URL 须以 http:// 或 https:// 开头");
      return;
    }
    if (editing) {
      const k0 = makeRowKey(editing);
      const next = favorites.map((x) => {
        if (makeRowKey(x) === k0) {
          return { title, url, addTime: editing.addTime };
        }
        return x;
      });
      persistAll(next, "已保存编辑（速开需 /reload 后生效）");
      closeBookmarkModal();
      return;
    }
    const addTime = dayjs().format("YYYY-MM-DD HH:mm:ss");
    const add: FavoriteItem = { title, url, addTime };
    const exists = favorites.some((f) => makeRowKey(f) === makeRowKey(add));
    if (exists) {
      messageApi.warning("已存在相同时间+标题+地址");
      return;
    }
    persistAll([add, ...favorites], "已添加（速开需 /reload 后生效）");
    closeBookmarkModal();
  };

  const onSaveConfig = (next: AppConfig) => {
    void (async () => {
      try {
        await invoke("save_app_config_cmd", { cfg: next });
        setConfig(next);
        (window.messageApi ?? messageFromHook).success("配置已保存");
      } catch (e) {
        console.error(e);
        (window.messageApi ?? messageFromHook).error(String(e));
      }
    })();
  };

  /** 写入新快捷键并触发后端重载 global-shortcut */
  const applyGlobalShortcut = useCallback(
    async (hotkey: string) => {
      if (!config) {
        return;
      }
      const next = { ...config, global_shortcut: hotkey };
      try {
        await invoke("save_app_config_cmd", { cfg: next });
        setConfig(next);
        hotkeysReleasedForRecordingRef.current = false;
        (window.messageApi ?? messageFromHook).success(`快捷键已更新为 ${formatShortcutLabel(hotkey)}`);
      } catch (e) {
        console.error(e);
        (window.messageApi ?? messageFromHook).error(String(e));
        try {
          await invoke("reapply_global_shortcut_from_config");
        } catch (e2) {
          console.error(e2);
          (window.messageApi ?? messageFromHook).error(`恢复快捷键失败：${String(e2)}`);
        }
        hotkeysReleasedForRecordingRef.current = false;
      }
    },
    [config, messageFromHook],
  );

  /** 不经过按键捕获，直接写入预设组合（探针失败或与第三方热键冲突时的兜底） */
  const applyPresetShortcut = useCallback(
    async (hotkey: string) => {
      setShortcutRecording(false);
      await applyGlobalShortcut(hotkey);
    },
    [applyGlobalShortcut],
  );

  const applyGlobalShortcutRef = useRef(applyGlobalShortcut);
  useEffect(() => {
    applyGlobalShortcutRef.current = applyGlobalShortcut;
  }, [applyGlobalShortcut]);

  useEffect(() => {
    shortcutRecordingRef.current = shortcutRecording;
  }, [shortcutRecording]);

  /** Alt+Space 由 Rust `start_hotkey_recording_probe` 在 OS 层捕获并派发本事件（WebView 往往收不到该组合） */
  useEffect(() => {
    if (!isTauriWebview()) {
      return;
    }
    const setup = listen<string>("shortcut-recording-result", (ev) => {
      if (!shortcutRecordingRef.current) {
        return;
      }
      if (shortcutCommitLockRef.current) {
        return;
      }
      shortcutCommitLockRef.current = true;
      void (async () => {
        try {
          await applyGlobalShortcutRef.current(ev.payload);
          setShortcutRecording(false);
        } finally {
          shortcutCommitLockRef.current = false;
        }
      })();
    });
    return () => {
      void setup.then((fn) => {
        fn();
      });
    };
  }, []);

  /** 全局快捷键 keydown 捕获：除 Alt+Space 外的组合在页面层解析；Alt+Space 仅走 Native 探针 */
  useEffect(() => {
    if (!shortcutRecording || !config) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const parsed = parseHotkeyFromKeydown(e);
      if (parsed === null) {
        void endShortcutRecordingCancelled();
        (window.messageApi ?? messageFromHook).info("已取消快捷键录入");
        return;
      }
      if (parsed === "") {
        return;
      }
      if (parsed === "__INVALID_NO_MODIFIER__") {
        (window.messageApi ?? messageFromHook).warning("请同时按住至少一个修饰键（如 Alt、Ctrl）再按目标键");
        return;
      }
      if (parsed === "Alt+Space") {
        return;
      }
      if (shortcutCommitLockRef.current) {
        return;
      }
      shortcutCommitLockRef.current = true;
      void (async () => {
        try {
          await applyGlobalShortcut(parsed);
          setShortcutRecording(false);
        } finally {
          shortcutCommitLockRef.current = false;
        }
      })();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shortcutRecording, config, applyGlobalShortcut, messageFromHook, endShortcutRecordingCancelled]);

  const onImport = () => {
    void (async () => {
      const f = await open({ filters: [{ name: "JSON", extensions: ["json"] }], multiple: false });
      if (f == null) {
        return;
      }
      const p = Array.isArray(f) ? f[0] : f;
      if (!p) {
        return;
      }
      try {
        await invoke("import_favorites_path", { path: p });
        await load();
        (window.messageApi ?? messageFromHook).success("导入已覆盖并写入磁盘");
      } catch (e) {
        (window.messageApi ?? messageFromHook).error(String(e));
      }
    })();
  };

  const onExport = () => {
    void (async () => {
      const p = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "favorites.json",
      });
      if (p == null) {
        return;
      }
      try {
        await invoke("export_favorites_path", { path: p });
        (window.messageApi ?? messageFromHook).success("已导出");
      } catch (e) {
        (window.messageApi ?? messageFromHook).error(String(e));
      }
    })();
  };

  /** 在系统浏览器中打开书签（Windows 走前台友好的 FileProtocolHandler） */
  const onOpenBookmarkUrl = (rawUrl: string) => {
    void (async () => {
      const url = rawUrl.trim();
      if (!url) {
        return;
      }
      try {
        await invoke("open_url_in_system_browser", { url });
      } catch (e) {
        console.error(e);
        (window.messageApi ?? messageFromHook).error(String(e));
      }
    })();
  };

  const openBookmarkModal = (item?: FavoriteItem) => {
    if (item) {
      setEditing(item);
      setDraftTitle(item.title);
      setDraftUrl(item.url);
    } else {
      setEditing(null);
      setDraftTitle("");
      setDraftUrl("");
    }
    setBookmarkModalOpen(true);
  };

  if (!isTauriWebview()) {
    return (
      <div className="p-4 text-stone-700">
        <p className="mb-2">
          管理收藏依赖 Tauri 与本地数据；在系统浏览器中无法调用后端。请使用{" "}
          <code className="rounded bg-stone-200 px-1">npm run tauri dev</code> 打开应用窗口操作。
        </p>
        <a className="text-blue-600 underline" href="/?view=palette">
          返回速开（浏览器预览）
        </a>
      </div>
    );
  }

  if (!config) {
    return <div className="flex h-full items-center justify-center bg-zinc-50 text-zinc-500">正在加载…</div>;
  }

  const shortcutDisplay = formatShortcutLabel(config.global_shortcut);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-zinc-50 font-sans text-zinc-900">
      {/* 左侧导航：对齐 Figma Make Layout；与主区同高铺满窗口 */}
      <aside className="flex min-h-0 w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-100/80 backdrop-blur-xl">
        <div className="p-8">
          <div className="mb-1 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-blue-500 to-blue-700 text-white shadow-lg shadow-blue-500/20">
              <Bookmark size={24} strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">网页快开</h1>
              <div className="flex items-center gap-1.5">
                <div className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Running</span>
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1.5 px-4 py-4">
          <button
            type="button"
            onClick={() => setSection("general")}
            className={
              section === "general"
                ? "flex w-full items-center gap-3 rounded-xl bg-white px-4 py-2.5 font-semibold text-blue-600 shadow-sm ring-1 ring-zinc-200 transition-all duration-200"
                : "flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-zinc-600 transition-all duration-200 hover:bg-zinc-200/50 hover:text-zinc-900"
            }
          >
            <SettingsIcon size={19} />
            <span>常规设置</span>
          </button>
          <button
            type="button"
            onClick={() => setSection("bookmarks")}
            className={
              section === "bookmarks"
                ? "flex w-full items-center gap-3 rounded-xl bg-white px-4 py-2.5 font-semibold text-blue-600 shadow-sm ring-1 ring-zinc-200 transition-all duration-200"
                : "flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-zinc-600 transition-all duration-200 hover:bg-zinc-200/50 hover:text-zinc-900"
            }
          >
            <Bookmark size={19} />
            <span>书签管理</span>
          </button>
        </nav>

        <div className="mt-auto p-6">
          <div className="rounded-2xl border border-zinc-200/50 bg-zinc-200/50 p-4">
            <p className="text-[11px] leading-relaxed text-zinc-500">
              快捷键已就绪。按下{" "}
              <span className="font-bold text-zinc-900">{shortcutDisplay}</span> 开启速开。
            </p>
          </div>
          <div className="mt-6 flex items-center justify-between text-zinc-400">
            <button type="button" className="p-1 transition-colors hover:text-zinc-600" aria-label="GitHub">
              <Github size={18} />
            </button>
            <span className="text-[10px] font-bold text-zinc-400">v{pkg.version}</span>
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-8 py-8 lg:px-12 lg:py-12">
          {section === "general" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <GeneralSection
              config={config}
              dataDir={dataDir}
              onSaveConfig={onSaveConfig}
              setConfig={setConfig}
              shortcutRecording={shortcutRecording}
              onApplyPresetShortcut={(hotkey) => void applyPresetShortcut(hotkey)}
              onToggleShortcutRecording={() => {
                if (shortcutRecording) {
                  void endShortcutRecordingCancelled();
                  (window.messageApi ?? messageFromHook).info("已取消快捷键录入");
                  return;
                }
                void beginShortcutRecording();
              }}
            />
            </div>
          ) : (
            <BookmarksSection
              q={q}
              setQ={setQ}
              filtered={filtered}
              totalCount={favorites.length}
              onImport={onImport}
              onExport={onExport}
              onOpenAdd={() => openBookmarkModal()}
              onOpenEdit={(f) => openBookmarkModal(f)}
              onDelete={onDelete}
              onOpenUrl={onOpenBookmarkUrl}
            />
          )}
        </div>
      </main>

      <Modal
        title={
          <span className="text-lg font-semibold">{editing ? "编辑书签" : "新建书签"}</span>
        }
        open={bookmarkModalOpen}
        onCancel={closeBookmarkModal}
        footer={null}
        closeIcon={<X size={20} className="text-zinc-400" />}
        classNames={{ header: "border-b border-zinc-100 bg-zinc-50/50", body: "pt-4" }}
        width={440}
        centered
        destroyOnClose
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitBookmarkRow();
          }}
          className="space-y-4"
        >
          <div className="flex items-center gap-3">
            <label htmlFor="bm-title" className="w-24 shrink-0 text-sm font-medium text-zinc-700">
              标题
            </label>
            <input
              id="bm-title"
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.currentTarget.value)}
              placeholder="例如：Google"
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm transition-all outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="bm-url" className="w-24 shrink-0 text-sm font-medium text-zinc-700">
              URL 地址
            </label>
            <input
              id="bm-url"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.currentTarget.value)}
              placeholder="https://..."
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm transition-all outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={closeBookmarkModal}
              className="flex-1 rounded-lg px-4 py-2 font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
            >
              保存
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** 常规设置：Figma 式快捷键按键录入 + 卡片布局；自启动立即写入 */
function GeneralSection({
  config,
  dataDir,
  setConfig,
  onSaveConfig,
  shortcutRecording,
  onApplyPresetShortcut,
  onToggleShortcutRecording,
}: {
  config: AppConfig;
  dataDir: string;
  setConfig: (c: AppConfig) => void;
  onSaveConfig: (c: AppConfig) => void;
  shortcutRecording: boolean;
  /** 直接应用预设热键字符串（如 Alt+Space） */
  onApplyPresetShortcut: (hotkey: string) => void;
  onToggleShortcutRecording: () => void;
}) {
  const shortcutButtonLabel = shortcutRecording ? "等待输入..." : formatShortcutLabel(config.global_shortcut);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="mb-1 text-2xl font-semibold">常规设置</h2>
        <p className="text-sm text-zinc-500">配置运行方式与全局唤醒快捷键；录入后由后端立即重载快捷键。</p>
      </section>

      <div className="space-y-8">
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
                <Keyboard size={20} />
              </div>
              <div className="min-w-0">
                <h3 className="font-medium">全局快捷键</h3>
                <p className="mt-1 text-sm text-zinc-500">使用此快捷键在任何地方快速唤醒书签搜索窗口。</p>
                <p className="mt-2 text-xs text-zinc-400">数据目录：{dataDir}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onToggleShortcutRecording}
              className={
                shortcutRecording
                  ? "shrink-0 rounded-lg border border-red-200 bg-red-50 px-4 py-2 font-medium text-red-600 animate-pulse transition-all"
                  : "shrink-0 rounded-lg border border-zinc-200 bg-white px-4 py-2 font-medium text-zinc-900 shadow-sm transition-all hover:border-blue-500 hover:text-blue-600"
              }
            >
              {shortcutButtonLabel}
            </button>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-zinc-500">
            Windows 下 <span className="font-medium text-zinc-700">Alt+Space</span>{" "}
            常被系统用于窗口菜单，网页里往往收不到；录入时已改为在系统层监听该组合。若仍无法录入（例如与 PowerToys
            等冲突），可点
            <button
              type="button"
              onClick={() => onApplyPresetShortcut("Alt+Space")}
              className="mx-1 font-medium text-blue-600 hover:underline"
            >
              一键设为 Alt + Space
            </button>
            直接保存。
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-200 text-zinc-600">
                <Power size={20} />
              </div>
              <div>
                <h3 className="font-medium">开机自启动</h3>
                <p className="mt-1 text-sm text-zinc-500">在 Windows 启动时自动运行应用。</p>
              </div>
            </div>
            <AutostartToggle
              checked={config.autostart}
              onChange={(v) => {
                const c = { ...config, autostart: v };
                setConfig(c);
                onSaveConfig(c);
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex gap-3 rounded-xl border border-zinc-100 bg-zinc-50/50 p-4">
            <Info size={18} className="mt-0.5 shrink-0 text-zinc-400" />
            <div>
              <p className="text-sm font-medium">关于缓存</p>
              <p className="mt-1 text-xs text-zinc-500">
                书签数据存储在本地。建议定期通过「书签管理」导出 JSON 备份以防数据丢失。
              </p>
            </div>
          </div>
          <div className="flex gap-3 rounded-xl border border-zinc-100 bg-zinc-50/50 p-4">
            <HelpCircle size={18} className="mt-0.5 shrink-0 text-zinc-400" />
            <div>
              <p className="text-sm font-medium">帮助中心</p>
              <p className="mt-1 text-xs text-zinc-500">
                若快捷键无效或冲突，请重新录入其它组合键；速开内可使用 /reload 重新加载数据。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** iOS 风格开关外观，行为与原先 Switch 一致 */
function AutostartToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none ${
        checked ? "bg-blue-600" : "bg-zinc-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/** 书签管理：表格 + 悬停操作工具条 */
function BookmarksSection({
  q,
  setQ,
  filtered,
  totalCount,
  onImport,
  onExport,
  onOpenAdd,
  onOpenEdit,
  onDelete,
  onOpenUrl,
}: {
  q: string;
  setQ: (s: string) => void;
  filtered: FavoriteItem[];
  totalCount: number;
  onImport: () => void;
  onExport: () => void;
  onOpenAdd: () => void;
  onOpenEdit: (f: FavoriteItem) => void;
  onDelete: (f: FavoriteItem) => void;
  onOpenUrl: (url: string) => void;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-nowrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="mb-1 text-2xl font-semibold">书签管理</h2>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-zinc-500">
            <span>管理您的所有快捷书签</span>
            <span className="h-1 w-1 shrink-0 rounded-full bg-zinc-300" />
            <span className="font-medium text-blue-600">共 {totalCount} 条数据</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onImport}
            title="导入"
            className="rounded-lg border border-transparent p-2 text-zinc-600 transition-colors hover:border-zinc-200 hover:bg-zinc-100"
          >
            <Upload size={18} />
          </button>
          <button
            type="button"
            onClick={onExport}
            title="导出"
            className="rounded-lg border border-transparent p-2 text-zinc-600 transition-colors hover:border-zinc-200 hover:bg-zinc-100"
          >
            <Download size={18} />
          </button>
          <button
            type="button"
            onClick={onOpenAdd}
            className="flex shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white shadow-sm transition-colors hover:bg-blue-700"
          >
            <Plus size={18} />
            <span>添加书签</span>
          </button>
        </div>
      </div>

      <div className="relative mt-6 mb-4 shrink-0">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-[18px] w-[18px] -translate-y-1/2 text-zinc-400" />
        <input
          type="search"
          placeholder="搜索书签标题或 URL..."
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          className="w-full rounded-xl border border-zinc-200 bg-zinc-50 py-2.5 pr-4 pl-10 text-sm transition-all outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <table className="w-full table-fixed text-left">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[34%]" />
              <col className="w-[24%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead className="sticky top-0 z-20 border-b border-zinc-200 bg-zinc-50 shadow-sm">
              <tr>
                <th className="px-6 py-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">标题</th>
                <th className="px-6 py-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">URL</th>
                <th className="px-6 py-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">添加时间</th>
                <th className="whitespace-nowrap px-6 py-3 text-right text-xs font-semibold tracking-wider text-zinc-500 uppercase">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filtered.map((bookmark) => {
                const rowKey = makeRowKey(bookmark);
                return (
                  <tr key={rowKey} className="transition-colors hover:bg-zinc-50/50">
                    <td className="min-w-0 px-6 py-4">
                      <span className="block truncate font-semibold text-zinc-900">{bookmark.title}</span>
                    </td>
                    <td className="min-w-0 px-6 py-4">
                      <span className="block truncate text-sm text-zinc-500">{bookmark.url}</span>
                    </td>
                    <td className="min-w-0 px-6 py-4">
                      <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-400">
                        <Clock size={14} className="shrink-0" />
                        <span className="truncate">{bookmark.addTime}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          title="访问"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onOpenUrl(bookmark.url);
                          }}
                          className="rounded-md p-1.5 text-zinc-400 transition-all hover:bg-green-50 hover:text-green-600"
                        >
                          <ExternalLink size={16} />
                        </button>
                        <button
                          type="button"
                          title="编辑"
                          onClick={() => onOpenEdit(bookmark)}
                          className="rounded-md p-1.5 text-zinc-400 transition-all hover:bg-blue-50 hover:text-blue-600"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          type="button"
                          title="删除"
                          onClick={() => onDelete(bookmark)}
                          className="rounded-md p-1.5 text-zinc-400 transition-all hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center italic text-zinc-400">
                    未找到匹配的书签
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function compareFav(a: FavoriteItem, b: FavoriteItem) {
  if (a.addTime === b.addTime) {
    return b.title.localeCompare(a.title, "zh-CN");
  }
  return b.addTime.localeCompare(a.addTime, "zh-Hans", { numeric: true });
}

function makeRowKey(f: FavoriteItem) {
  return `${f.addTime}::${f.title}::${f.url}`;
}

export function AdminRoot() {
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <App className="h-full min-h-0">
        <AdminView />
      </App>
    </ConfigProvider>
  );
}
