import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { isEnabled } from '@tauri-apps/plugin-autostart'
import { App, ConfigProvider, Modal, Popconfirm, theme } from 'antd'
import {
  Bookmark,
  Copy,
  Download,
  Edit2,
  ExternalLink,
  Keyboard,
  Plus,
  Power,
  Search,
  Settings as SettingsIcon,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, FavoriteItem } from '../types/favorite'
import { isTauriWebview } from '../utils/tauriEnv'
import { PREVIEW_CONFIG, PREVIEW_FAVORITES } from '../utils/previewData'
import { Seal } from '../components/Seal'
import pkg from '../../package.json'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

/** 管理页分区 */
type AdminSection = 'general' | 'bookmarks'

/**
 * 侧栏与按钮展示用：将磁盘中的 `Alt+Space` 转为更易读的 `Alt + Space`
 */
function formatShortcutLabel(raw: string): string {
  const t = raw.trim()
  if (!t) {
    return '例如 Alt + Space'
  }
  return t.split('+').join(' + ')
}

/** 快捷键字符串 → 键帽数组 */
function shortcutChips(raw: string): string[] {
  return raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
}

/** 相对时间（悬停可见完整时间戳）；解析失败时回退原文 */
function relativeFrom(addTime: string): string {
  const d = dayjs(addTime)
  return d.isValid() ? d.fromNow() : addTime
}

/**
 * 从 keydown 解析 global-hotkey 字符串（与 `app.json` / global-hotkey 的 Code 命名一致，如 Alt+Space、Ctrl+Shift+KeyA）
 * @returns 合法组合键；`null` 表示用户按 Esc 取消；`""` 表示仅修饰键、忽略本次 keydown
 */
function parseHotkeyFromKeydown(e: KeyboardEvent): string | null | '' {
  if (e.key === 'Escape') {
    return null
  }
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') {
    return ''
  }
  const mods: string[] = []
  if (e.ctrlKey) {
    mods.push('Ctrl')
  }
  if (e.altKey) {
    mods.push('Alt')
  }
  if (e.shiftKey) {
    mods.push('Shift')
  }
  if (e.metaKey) {
    mods.push('Super')
  }
  if (mods.length === 0) {
    return '__INVALID_NO_MODIFIER__'
  }
  const main = e.code
  if (!main) {
    return '__INVALID_NO_MODIFIER__'
  }
  return [...mods, main].join('+')
}

/**
 * 管理页：纸面工作台 + 墨色按钮 + 玉色点缀；业务逻辑与原版一致
 */
export function AdminView() {
  const { message: messageFromHook } = App.useApp()
  useEffect(() => {
    if (!window.messageApi) {
      window.messageApi = messageFromHook
    }
  }, [messageFromHook])

  const [dataDir, setDataDir] = useState<string>('')
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [q, setQ] = useState('')

  const [draftTitle, setDraftTitle] = useState('')
  const [draftUrl, setDraftUrl] = useState('')
  /** 正在编辑的原记录（以 addTime+title+url 定位） */
  const [editing, setEditing] = useState<FavoriteItem | null>(null)
  /** 书签添加/编辑弹层 */
  const [bookmarkModalOpen, setBookmarkModalOpen] = useState(false)
  /** 当前侧栏选中的分区 */
  const [section, setSection] = useState<AdminSection>('general')
  /** 是否正在录入全局快捷键（按键捕获） */
  const [shortcutRecording, setShortcutRecording] = useState(false)
  /** 录入开始时由 Rust 注销并挂起探针；取消/切页须从磁盘恢复注册，否则会长时间无热键 */
  const hotkeysReleasedForRecordingRef = useRef(false)
  /** 与 shortcutRecording 同步，供 Tauri 事件回调判断是否在录入态 */
  const shortcutRecordingRef = useRef(false)
  /** 防止 JS 与 Native 探针对同一组合重复提交 */
  const shortcutCommitLockRef = useRef(false)

  const load = useCallback(async () => {
    if (!isTauriWebview()) {
      // 浏览器预览：示例数据，便于纯前端调整界面
      setDataDir('C:\\portable\\my-tools\\favorites.json（预览示例）')
      setFavorites(PREVIEW_FAVORITES)
      setConfig(PREVIEW_CONFIG)
      return
    }
    const path = await invoke<string>('get_data_dir_for_ui')
    setDataDir(path)
    const list = await invoke<FavoriteItem[]>('get_favorites_from_disk')
    const c = await invoke<AppConfig>('get_app_config_cmd')
    setFavorites([...list].sort(compareFav))
    setConfig(c)
    const b = await isEnabled().catch(() => false)
    if (b !== c.autostart) {
      setConfig({ ...c, autostart: b })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 从磁盘恢复全局热键（录入取消、切走页面、保存失败时使用） */
  const restoreGlobalShortcutIfNeeded = useCallback(async () => {
    if (!hotkeysReleasedForRecordingRef.current) {
      return
    }
    hotkeysReleasedForRecordingRef.current = false
    try {
      await invoke('reapply_global_shortcut_from_config')
    } catch (e) {
      console.error(e)
      ;(window.messageApi ?? messageFromHook).error(`恢复快捷键失败：${String(e)}`)
    }
  }, [messageFromHook])

  /** 开始录入：Rust 注销原热键并挂 Alt+Space 的 OS 层探针（WebView 收不到该组合）；其它组合仍由页面 keydown 解析 */
  const beginShortcutRecording = useCallback(async () => {
    if (!isTauriWebview()) {
      ;(window.messageApi ?? messageFromHook).info('浏览器预览模式不支持录制快捷键')
      return
    }
    try {
      await invoke('start_hotkey_recording_probe')
      hotkeysReleasedForRecordingRef.current = true
    } catch (e) {
      console.error(e)
      ;(window.messageApi ?? messageFromHook).error(
        `无法开始录入：${String(e)}（若与其它软件热键冲突，可先关闭冲突项或使用下方「一键设为 Alt + Space」）`,
      )
      return
    }
    setShortcutRecording(true)
    ;(window.messageApi ?? messageFromHook).info('请按下想要设置的组合键…')
  }, [messageFromHook])

  /** 取消录入并尽量恢复热键 */
  const endShortcutRecordingCancelled = useCallback(async () => {
    setShortcutRecording(false)
    await restoreGlobalShortcutIfNeeded()
  }, [restoreGlobalShortcutIfNeeded])

  /** 离开常规设置时结束录入并恢复热键 */
  useEffect(() => {
    if (section !== 'general') {
      void endShortcutRecordingCancelled()
    }
  }, [section, endShortcutRecordingCancelled])

  /** 标题或 URL 匹配；标题命中的行排在仅 URL 命中的行之前，组内仍按 compareFav 排序 */
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) {
      return favorites
    }
    const titleHits: FavoriteItem[] = []
    const urlOnly: FavoriteItem[] = []
    for (const f of favorites) {
      const titleOk = f.title.toLowerCase().includes(t)
      const urlOk = f.url.toLowerCase().includes(t)
      if (titleOk) {
        titleHits.push(f)
      } else if (urlOk) {
        urlOnly.push(f)
      }
    }
    titleHits.sort(compareFav)
    urlOnly.sort(compareFav)
    return [...titleHits, ...urlOnly]
  }, [favorites, q])

  /** 先乐观更新界面，再落盘；浏览器预览只改内存 */
  const persistAll = useCallback(
    (next: FavoriteItem[], okMsg: string) => {
      setFavorites([...next].sort(compareFav))
      if (!isTauriWebview()) {
        ;(window.messageApi ?? messageFromHook).info('预览模式：数据仅保存在内存中')
        return
      }
      void (async () => {
        try {
          await invoke('save_favorites_replace', { items: next })
          ;(window.messageApi ?? messageFromHook).success(okMsg)
        } catch (e) {
          console.error(e)
          // 落盘失败时回读磁盘，避免界面与磁盘不一致
          await invoke<FavoriteItem[]>('get_favorites_from_disk')
            .then((list) => setFavorites([...list].sort(compareFav)))
            .catch(() => {})
          ;(window.messageApi ?? messageFromHook).error(String(e))
        }
      })()
    },
    [messageFromHook],
  )

  const onDelete = (f: FavoriteItem) => {
    const k = makeRowKey(f)
    const next = favorites.filter((x) => makeRowKey(x) !== k)
    persistAll(next, '已删除')
  }

  const closeBookmarkModal = () => {
    setBookmarkModalOpen(false)
    setEditing(null)
    setDraftTitle('')
    setDraftUrl('')
  }

  /** 提交书签表单：新增或编辑，校验规则与原先一致 */
  const submitBookmarkRow = () => {
    const title = draftTitle.trim()
    const url = draftUrl.trim()
    const messageApi = window.messageApi ?? messageFromHook
    if (title.length === 0) {
      messageApi.warning('请填写标题')
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      messageApi.warning('URL 须以 http:// 或 https:// 开头')
      return
    }
    if (editing) {
      const k0 = makeRowKey(editing)
      const next = favorites.map((x) => {
        if (makeRowKey(x) === k0) {
          return { title, url, addTime: editing.addTime }
        }
        return x
      })
      persistAll(next, '已保存编辑')
      closeBookmarkModal()
      return
    }
    const addTime = dayjs().format('YYYY-MM-DD HH:mm:ss')
    const add: FavoriteItem = { title, url, addTime }
    const exists = favorites.some((f) => makeRowKey(f) === makeRowKey(add))
    if (exists) {
      messageApi.warning('已存在相同时间+标题+地址')
      return
    }
    persistAll([add, ...favorites], '已添加')
    closeBookmarkModal()
  }

  const onSaveConfig = (next: AppConfig) => {
    void (async () => {
      if (!isTauriWebview()) {
        setConfig(next)
        ;(window.messageApi ?? messageFromHook).info('预览模式：配置仅保存在内存中')
        return
      }
      try {
        await invoke('save_app_config_cmd', { cfg: next })
        setConfig(next)
        ;(window.messageApi ?? messageFromHook).success('配置已保存')
      } catch (e) {
        console.error(e)
        ;(window.messageApi ?? messageFromHook).error(String(e))
      }
    })()
  }

  /** 写入新快捷键并触发后端重载 global-shortcut */
  const applyGlobalShortcut = useCallback(
    async (hotkey: string) => {
      if (!config) {
        return
      }
      const next = { ...config, global_shortcut: hotkey }
      if (!isTauriWebview()) {
        setConfig(next)
        ;(window.messageApi ?? messageFromHook).info('预览模式：快捷键仅保存在内存中')
        return
      }
      try {
        await invoke('save_app_config_cmd', { cfg: next })
        setConfig(next)
        hotkeysReleasedForRecordingRef.current = false
        ;(window.messageApi ?? messageFromHook).success(
          `快捷键已更新为 ${formatShortcutLabel(hotkey)}`,
        )
      } catch (e) {
        console.error(e)
        ;(window.messageApi ?? messageFromHook).error(String(e))
        try {
          await invoke('reapply_global_shortcut_from_config')
        } catch (e2) {
          console.error(e2)
          ;(window.messageApi ?? messageFromHook).error(`恢复快捷键失败：${String(e2)}`)
        }
        hotkeysReleasedForRecordingRef.current = false
      }
    },
    [config, messageFromHook],
  )

  /** 不经过按键捕获，直接写入预设组合（探针失败或与第三方热键冲突时的兜底） */
  const applyPresetShortcut = useCallback(
    async (hotkey: string) => {
      setShortcutRecording(false)
      await applyGlobalShortcut(hotkey)
    },
    [applyGlobalShortcut],
  )

  const applyGlobalShortcutRef = useRef(applyGlobalShortcut)
  useEffect(() => {
    applyGlobalShortcutRef.current = applyGlobalShortcut
  }, [applyGlobalShortcut])

  useEffect(() => {
    shortcutRecordingRef.current = shortcutRecording
  }, [shortcutRecording])

  /** Alt+Space 由 Rust `start_hotkey_recording_probe` 在 OS 层捕获并派发本事件（WebView 往往收不到该组合） */
  useEffect(() => {
    if (!isTauriWebview()) {
      return
    }
    const setup = listen<string>('shortcut-recording-result', (ev) => {
      if (!shortcutRecordingRef.current) {
        return
      }
      if (shortcutCommitLockRef.current) {
        return
      }
      shortcutCommitLockRef.current = true
      void (async () => {
        try {
          await applyGlobalShortcutRef.current(ev.payload)
          setShortcutRecording(false)
        } finally {
          shortcutCommitLockRef.current = false
        }
      })()
    })
    return () => {
      void setup.then((fn) => {
        fn()
      })
    }
  }, [])

  /** 全局快捷键 keydown 捕获：除 Alt+Space 外的组合在页面层解析；Alt+Space 仅走 Native 探针 */
  useEffect(() => {
    if (!shortcutRecording || !config) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const parsed = parseHotkeyFromKeydown(e)
      if (parsed === null) {
        void endShortcutRecordingCancelled()
        ;(window.messageApi ?? messageFromHook).info('已取消快捷键录入')
        return
      }
      if (parsed === '') {
        return
      }
      if (parsed === '__INVALID_NO_MODIFIER__') {
        ;(window.messageApi ?? messageFromHook).warning(
          '请同时按住至少一个修饰键（如 Alt、Ctrl）再按目标键',
        )
        return
      }
      if (parsed === 'Alt+Space') {
        return
      }
      if (shortcutCommitLockRef.current) {
        return
      }
      shortcutCommitLockRef.current = true
      void (async () => {
        try {
          await applyGlobalShortcut(parsed)
          setShortcutRecording(false)
        } finally {
          shortcutCommitLockRef.current = false
        }
      })()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [
    shortcutRecording,
    config,
    applyGlobalShortcut,
    messageFromHook,
    endShortcutRecordingCancelled,
  ])

  const onImport = () => {
    if (!isTauriWebview()) {
      ;(window.messageApi ?? messageFromHook).info('浏览器预览模式不支持导入')
      return
    }
    void (async () => {
      const f = await open({ filters: [{ name: 'JSON', extensions: ['json'] }], multiple: false })
      if (f == null) {
        return
      }
      const p = Array.isArray(f) ? f[0] : f
      if (!p) {
        return
      }
      try {
        await invoke('import_favorites_path', { path: p })
        await load()
        ;(window.messageApi ?? messageFromHook).success('导入已覆盖并写入磁盘')
      } catch (e) {
        ;(window.messageApi ?? messageFromHook).error(String(e))
      }
    })()
  }

  const onExport = () => {
    if (!isTauriWebview()) {
      ;(window.messageApi ?? messageFromHook).info('浏览器预览模式不支持导出')
      return
    }
    void (async () => {
      const p = await save({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        defaultPath: 'favorites.json',
      })
      if (p == null) {
        return
      }
      try {
        await invoke('export_favorites_path', { path: p })
        ;(window.messageApi ?? messageFromHook).success('已导出')
      } catch (e) {
        ;(window.messageApi ?? messageFromHook).error(String(e))
      }
    })()
  }

  /** 在系统浏览器中打开书签（Windows 走前台友好的 FileProtocolHandler） */
  const onOpenBookmarkUrl = (rawUrl: string) => {
    void (async () => {
      const url = rawUrl.trim()
      if (!url) {
        return
      }
      try {
        if (isTauriWebview()) {
          await invoke('open_url_in_system_browser', { url })
        } else {
          window.open(url, '_blank', 'noopener,noreferrer')
        }
      } catch (e) {
        console.error(e)
        ;(window.messageApi ?? messageFromHook).error(String(e))
      }
    })()
  }

  const openBookmarkModal = (item?: FavoriteItem) => {
    if (item) {
      setEditing(item)
      setDraftTitle(item.title)
      setDraftUrl(item.url)
    } else {
      setEditing(null)
      setDraftTitle('')
      setDraftUrl('')
    }
    setBookmarkModalOpen(true)
  }

  const copyDataDir = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(dataDir)
        ;(window.messageApi ?? messageFromHook).success('数据目录已复制')
      } catch {
        ;(window.messageApi ?? messageFromHook).error('复制失败，请手动选择路径复制')
      }
    })()
  }

  if (!config) {
    return (
      <div className='flex h-full items-center justify-center bg-paper-50 text-[13px] text-graphite-400'>
        正在加载…
      </div>
    )
  }

  return (
    <div className='flex h-full min-h-0 w-full overflow-hidden bg-paper-50 font-sans text-graphite-900'>
      {/* 左侧导航：品牌 + 分区 + 快捷键速览 */}
      <aside className='flex min-h-0 w-60 shrink-0 flex-col border-r border-hairline bg-white'>
        <div className='px-5 pb-2 pt-6'>
          <div className='flex items-center gap-3'>
            <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-graphite-900 shadow-sm'>
              <span aria-hidden className='h-2.5 w-2.5 rotate-45 rounded-[3px] bg-jade-400' />
            </div>
            <div className='min-w-0'>
              <h1 className='text-[15px] font-semibold leading-5'>网页快开</h1>
              <div className='mt-0.5 flex items-center gap-1.5'>
                <span className='h-1.5 w-1.5 rounded-full bg-jade-400' />
                <span className='text-[11px] text-graphite-400'>运行中</span>
              </div>
            </div>
          </div>
        </div>

        <nav className='flex-1 space-y-1 px-3 py-4'>
          <NavButton
            active={section === 'general'}
            icon={<SettingsIcon size={17} />}
            onClick={() => setSection('general')}
          >
            常规设置
          </NavButton>
          <NavButton
            active={section === 'bookmarks'}
            icon={<Bookmark size={17} />}
            onClick={() => setSection('bookmarks')}
          >
            书签管理
          </NavButton>
        </nav>

        <div className='border-t border-hairline p-4'>
          <div className='rounded-xl bg-paper-50 px-3 py-2.5'>
            <div className='text-[11px] text-graphite-400'>全局快捷键</div>
            <div className='mt-1.5 flex flex-wrap items-center gap-1'>
              {shortcutChips(config.global_shortcut).map((p) => (
                <kbd key={p} className='kbd-light'>
                  {p}
                </kbd>
              ))}
            </div>
          </div>
          <div className='mt-3 px-1 font-mono text-[11px] text-graphite-400'>v{pkg.version}</div>
        </div>
      </aside>

      <main className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
        <div className='mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-8 py-8 lg:px-10'>
          {section === 'general' ? (
            <div className='min-h-0 flex-1 overflow-y-auto'>
              <GeneralSection
                config={config}
                dataDir={dataDir}
                onSaveConfig={onSaveConfig}
                setConfig={setConfig}
                shortcutRecording={shortcutRecording}
                onApplyPresetShortcut={(hotkey) => void applyPresetShortcut(hotkey)}
                onToggleShortcutRecording={() => {
                  if (shortcutRecording) {
                    void endShortcutRecordingCancelled()
                    ;(window.messageApi ?? messageFromHook).info('已取消快捷键录入')
                    return
                  }
                  void beginShortcutRecording()
                }}
                onCopyDataDir={copyDataDir}
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
        title={<span className='text-[15px] font-semibold'>{editing ? '编辑书签' : '新建书签'}</span>}
        open={bookmarkModalOpen}
        onCancel={closeBookmarkModal}
        footer={null}
        closeIcon={<X size={18} className='text-graphite-400' />}
        width={420}
        centered
        destroyOnClose
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submitBookmarkRow()
          }}
          className='space-y-4 pt-1'
        >
          <div>
            <label
              htmlFor='bm-title'
              className='mb-1.5 block text-[12px] font-medium text-graphite-500'
            >
              标题
            </label>
            <input
              id='bm-title'
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.currentTarget.value)}
              placeholder='例如：GitHub'
              className='w-full rounded-lg border border-hairline bg-paper-50/60 px-3 py-2 text-[13px] outline-none transition focus:border-jade-400 focus:bg-white focus:ring-2 focus:ring-jade-400/20'
            />
          </div>
          <div>
            <label
              htmlFor='bm-url'
              className='mb-1.5 block text-[12px] font-medium text-graphite-500'
            >
              网址
            </label>
            <input
              id='bm-url'
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.currentTarget.value)}
              placeholder='https://…'
              className='w-full rounded-lg border border-hairline bg-paper-50/60 px-3 py-2 font-mono text-[12.5px] outline-none transition focus:border-jade-400 focus:bg-white focus:ring-2 focus:ring-jade-400/20'
            />
          </div>
          <div className='flex gap-2.5 pt-2'>
            <button
              type='button'
              onClick={closeBookmarkModal}
              className='flex-1 rounded-lg border border-hairline bg-white px-4 py-2 text-[13px] font-medium text-graphite-700 transition-colors hover:bg-paper-50'
            >
              取消
            </button>
            <button
              type='submit'
              className='flex-1 rounded-lg bg-graphite-900 px-4 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-graphite-800'
            >
              保存
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

/** 侧栏导航项 */
function NavButton({
  active,
  icon,
  onClick,
  children,
}: {
  active: boolean
  icon: React.ReactNode
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-colors ' +
        (active
          ? 'bg-paper-100 font-medium text-graphite-900'
          : 'text-graphite-500 hover:bg-paper-50 hover:text-graphite-800')
      }
    >
      <span className={active ? 'text-jade-600' : 'text-graphite-400'}>{icon}</span>
      <span>{children}</span>
    </button>
  )
}

/** 常规设置：键帽化快捷键 + 自启动；自启动立即写入 */
function GeneralSection({
  config,
  dataDir,
  setConfig,
  onSaveConfig,
  shortcutRecording,
  onApplyPresetShortcut,
  onToggleShortcutRecording,
  onCopyDataDir,
}: {
  config: AppConfig
  dataDir: string
  setConfig: (c: AppConfig) => void
  onSaveConfig: (c: AppConfig) => void
  shortcutRecording: boolean
  /** 直接应用预设热键字符串（如 Alt+Space） */
  onApplyPresetShortcut: (hotkey: string) => void
  onToggleShortcutRecording: () => void
  onCopyDataDir: () => void
}) {
  return (
    <div className='space-y-5'>
      <header className='shrink-0'>
        <h2 className='text-[20px] font-semibold leading-7'>常规设置</h2>
        <p className='mt-1 text-[13px] text-graphite-500'>调整唤起方式与应用行为。</p>
      </header>

      <section className='rounded-xl border border-hairline bg-white p-5'>
        <div className='flex items-start gap-4'>
          <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-jade-50 text-jade-700'>
            <Keyboard size={20} />
          </div>
          <div className='min-w-0 flex-1'>
            <h3 className='text-[14px] font-semibold leading-5'>全局快捷键</h3>
            <p className='mt-1 text-[12.5px] text-graphite-500'>
              在任何界面按下它，立即唤起搜索条。
            </p>

            <div className='mt-3.5 flex flex-wrap items-center gap-2'>
              {shortcutRecording ? (
                <>
                  <span className='inline-flex items-center gap-2 rounded-lg bg-jade-50 px-3 py-1.5 text-[12.5px] font-medium text-jade-700 ring-1 ring-jade-200 animate-pulse'>
                    <span className='h-1.5 w-1.5 rounded-full bg-jade-600' />
                    按下新的组合键…
                  </span>
                  <button
                    type='button'
                    onClick={onToggleShortcutRecording}
                    className='rounded-lg px-2 py-1.5 text-[12px] text-graphite-500 transition-colors hover:bg-paper-50 hover:text-graphite-800'
                  >
                    取消（Esc）
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  onClick={onToggleShortcutRecording}
                  title='点击修改快捷键'
                  className='group flex items-center gap-1.5 rounded-lg p-1 transition-colors hover:bg-paper-50'
                >
                  {shortcutChips(config.global_shortcut).map((p) => (
                    <kbd key={p} className='kbd-light'>
                      {p}
                    </kbd>
                  ))}
                  <span className='ml-1 text-[11.5px] text-graphite-400 group-hover:text-jade-700'>
                    修改
                  </span>
                </button>
              )}
            </div>

            <p className='mt-3.5 text-[11.5px] leading-relaxed text-graphite-400'>
              Windows 下 <span className='font-mono'>Alt+Space</span>{' '}
              常被系统窗口菜单占用，录入时已在系统层监听该组合；若与 PowerToys
              等软件冲突而无法录入，可
              <button
                type='button'
                onClick={() => onApplyPresetShortcut('Alt+Space')}
                className='mx-0.5 font-medium text-jade-700 hover:underline'
              >
                一键设为 Alt + Space
              </button>
              直接保存。
            </p>

            <div className='mt-4 flex items-center gap-2 border-t border-hairline pt-3.5'>
              <span className='shrink-0 text-[11px] text-graphite-400'>数据目录</span>
              <code
                className='min-w-0 flex-1 truncate font-mono text-[11px] text-graphite-500'
                title={dataDir}
              >
                {dataDir}
              </code>
              <button
                type='button'
                onClick={onCopyDataDir}
                title='复制数据目录路径'
                className='flex shrink-0 items-center gap-1 rounded-md p-1 text-graphite-400 transition-colors hover:bg-paper-50 hover:text-jade-700'
              >
                <Copy size={13} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className='rounded-xl border border-hairline bg-white p-5'>
        <div className='flex items-center gap-4'>
          <div className='flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-paper-100 text-graphite-700'>
            <Power size={20} />
          </div>
          <div className='min-w-0 flex-1'>
            <h3 className='text-[14px] font-semibold leading-5'>开机自启动</h3>
            <p className='mt-1 text-[12.5px] text-graphite-500'>
              登录 Windows 时自动运行，随时可用。
            </p>
          </div>
          <AutostartToggle
            checked={config.autostart}
            onChange={(v) => {
              const c = { ...config, autostart: v }
              setConfig(c)
              onSaveConfig(c)
            }}
          />
        </div>
      </section>
    </div>
  )
}

/** iOS 风格开关外观，行为与原先 Switch 一致 */
function AutostartToggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-jade-400/40 ${
        checked ? 'bg-jade-600' : 'bg-graphite-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

/** 书签管理：印章列表 + 悬停操作 + 删除确认 */
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
  q: string
  setQ: (s: string) => void
  filtered: FavoriteItem[]
  totalCount: number
  onImport: () => void
  onExport: () => void
  onOpenAdd: () => void
  onOpenEdit: (f: FavoriteItem) => void
  onDelete: (f: FavoriteItem) => void
  onOpenUrl: (url: string) => void
}) {
  return (
    <div className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'>
      <header className='flex shrink-0 flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-[20px] font-semibold leading-7'>书签管理</h2>
          <p className='mt-1 text-[13px] text-graphite-500'>
            {q.trim() ? (
              <>
                匹配 {filtered.length} 条 · 共 {totalCount} 条收藏
              </>
            ) : (
              <>共 {totalCount} 条收藏 · 最近添加的在前</>
            )}
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <button
            type='button'
            onClick={onImport}
            title='导入 JSON（将覆盖现有收藏）'
            className='flex items-center gap-1.5 rounded-lg border border-hairline bg-white px-3 py-2 text-[12.5px] font-medium text-graphite-700 transition-colors hover:bg-paper-50'
          >
            <Upload size={15} />
            导入
          </button>
          <button
            type='button'
            onClick={onExport}
            title='导出 JSON'
            className='flex items-center gap-1.5 rounded-lg border border-hairline bg-white px-3 py-2 text-[12.5px] font-medium text-graphite-700 transition-colors hover:bg-paper-50'
          >
            <Download size={15} />
            导出
          </button>
          <button
            type='button'
            onClick={onOpenAdd}
            className='flex items-center gap-1.5 rounded-lg bg-graphite-900 px-3.5 py-2 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-graphite-800'
          >
            <Plus size={15} />
            添加书签
          </button>
        </div>
      </header>

      <div className='relative mt-5 shrink-0'>
        <Search
          size={16}
          className='pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-graphite-400'
        />
        <input
          type='search'
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder='搜索标题或网址'
          className='w-full rounded-lg border border-hairline bg-white py-2.5 pl-9 pr-9 text-[13px] outline-none transition placeholder:text-graphite-400 focus:border-jade-400 focus:ring-2 focus:ring-jade-400/20 [&::-webkit-search-cancel-button]:hidden'
        />
        {q ? (
          <button
            type='button'
            onClick={() => setQ('')}
            title='清除搜索'
            className='absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-graphite-400 transition-colors hover:bg-paper-50 hover:text-graphite-700'
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className='mt-4 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-white'>
        <div className='admin-scroll min-h-0 flex-1 overflow-auto overscroll-contain'>
          {filtered.map((bookmark) => {
            const rowKey = makeRowKey(bookmark)
            return (
              <div
                key={rowKey}
                className='group flex items-center gap-3 border-b border-hairline px-4 py-3 transition-colors last:border-b-0 hover:bg-paper-50'
              >
                <Seal
                  url={bookmark.url}
                  title={bookmark.title}
                  variant='light'
                  className='h-9 w-9 rounded-[10px] text-[14px]'
                />
                <div className='min-w-0 flex-1'>
                  <div className='truncate text-[13.5px] font-medium leading-5 text-graphite-900'>
                    {bookmark.title}
                  </div>
                  <div className='truncate font-mono text-[11.5px] leading-4 text-graphite-400'>
                    {bookmark.url}
                  </div>
                </div>
                <div
                  className='hidden w-28 shrink-0 text-right text-[12px] tabular-nums text-graphite-400 sm:block'
                  title={bookmark.addTime}
                >
                  {relativeFrom(bookmark.addTime)}
                </div>
                <div className='flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100'>
                  <button
                    type='button'
                    title='在浏览器打开'
                    onClick={() => onOpenUrl(bookmark.url)}
                    className='rounded-md p-1.5 text-graphite-400 transition-colors hover:bg-jade-50 hover:text-jade-700'
                  >
                    <ExternalLink size={15} />
                  </button>
                  <button
                    type='button'
                    title='编辑'
                    onClick={() => onOpenEdit(bookmark)}
                    className='rounded-md p-1.5 text-graphite-400 transition-colors hover:bg-paper-100 hover:text-graphite-900'
                  >
                    <Edit2 size={15} />
                  </button>
                  <Popconfirm
                    title='删除书签'
                    description={`确定删除「${bookmark.title}」吗？`}
                    okText='删除'
                    cancelText='取消'
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDelete(bookmark)}
                  >
                    <button
                      type='button'
                      title='删除'
                      className='rounded-md p-1.5 text-graphite-400 transition-colors hover:bg-red-50 hover:text-red-600'
                    >
                      <Trash2 size={15} />
                    </button>
                  </Popconfirm>
                </div>
              </div>
            )
          })}

          {totalCount === 0 ? (
            <div className='flex flex-col items-center justify-center px-6 py-16 text-center'>
              <span aria-hidden className='h-3 w-3 rotate-45 rounded-[4px] bg-jade-300' />
              <div className='mt-4 text-[14px] font-medium text-graphite-900'>还没有收藏</div>
              <p className='mt-1.5 max-w-xs text-[12.5px] leading-relaxed text-graphite-400'>
                添加第一个常用网址，之后随时按全局快捷键唤起搜索条直达。
              </p>
              <button
                type='button'
                onClick={onOpenAdd}
                className='mt-5 flex items-center gap-1.5 rounded-lg bg-graphite-900 px-3.5 py-2 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-graphite-800'
              >
                <Plus size={15} />
                添加书签
              </button>
            </div>
          ) : null}

          {totalCount > 0 && filtered.length === 0 ? (
            <div className='flex flex-col items-center justify-center px-6 py-16 text-center'>
              <div className='text-[14px] font-medium text-graphite-900'>
                没有匹配“{q.trim()}”的书签
              </div>
              <button
                type='button'
                onClick={() => setQ('')}
                className='mt-3 rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-graphite-700 transition-colors hover:bg-paper-50'
              >
                清除搜索
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function compareFav(a: FavoriteItem, b: FavoriteItem) {
  if (a.addTime === b.addTime) {
    return b.title.localeCompare(a.title, 'zh-CN')
  }
  return b.addTime.localeCompare(a.addTime, 'zh-Hans', { numeric: true })
}

function makeRowKey(f: FavoriteItem) {
  return `${f.addTime}::${f.title}::${f.url}`
}

export function AdminRoot() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: { colorPrimary: '#0e8f6e', colorInfo: '#0e8f6e', borderRadius: 8 },
      }}
    >
      <App className='h-full min-h-0'>
        <AdminView />
      </App>
    </ConfigProvider>
  )
}
