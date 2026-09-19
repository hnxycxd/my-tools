import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { match as pinyinMatch } from 'pinyin-pro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppEntry } from '../types/app'
import type { FavoriteItem } from '../types/favorite'
import { isTauriWebview } from '../utils/tauriEnv'
import { PREVIEW_APP_ICONS, PREVIEW_APPS, PREVIEW_CONFIG, PREVIEW_FAVORITES } from '../utils/previewData'
import { Seal } from '../components/Seal'

type PaletteRow =
  | { kind: 'fav'; item: FavoriteItem }
  | { kind: 'app'; name: string; target: string }
  | { kind: 'web'; url: string; title: string; subtitle: string }
  | { kind: 'cmd'; title: string; subtitle: string }

/** 裸域名或完整 URL 视为网址，直接打开而非送去搜索 */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(s)
}

function normalizeUrl(s: string): string {
  return /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`
}

/**
 * 关键字是否命中名称：字面子串（英文名如 QQ、VSCode）或拼音/首字母（wx、weixin → 微信）。
 * 返回是否命中以及是否从首字符命中（用于前缀优先排序）；pinyin-pro match 无命中返回 null。
 * 统一在小写形态上匹配，保证下标一致且对 ASCII 名称大小写不敏感。
 */
function nameMatch(name: string, k: string): { hit: boolean; fromStart: boolean } {
  const n = name.toLowerCase()
  const py = pinyinMatch(n, k)
  if (n.includes(k) || (py && py.length > 0)) {
    return { hit: true, fromStart: n.startsWith(k) || (!!py && py[0] === 0) }
  }
  return { hit: false, fromStart: false }
}

/** 把 `Alt+Space` 转成键帽数组 */
function shortcutParts(raw: string): string[] {
  return raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * 速开：紧凑置顶窗口（无全屏蒙层），失焦即关。
 * 深墨面板 + 玉色点缀；输入过滤收藏与本机应用，支持网址直达与必应搜索，底部常驻键位提示。
 */
export function PaletteView() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const [raw, setRaw] = useState('')
  /** 每次窗口被唤起时 +1，重放入场动画 */
  const [popKey, setPopKey] = useState(0)
  const [shortcutLabel, setShortcutLabel] = useState('')

  const [items, setItems] = useState<FavoriteItem[]>([])
  const [apps, setApps] = useState<AppEntry[]>([])
  /** 快捷方式路径 → 应用图标 data URI；仅当前命中的行才会请求 */
  const [appIcons, setAppIcons] = useState<Record<string, string>>(() =>
    isTauriWebview() ? {} : PREVIEW_APP_ICONS,
  )
  const [sel, setSel] = useState(0)

  useEffect(() => {
    // 过滤关键词变化时，预选回到第一条
    setSel(0)
  }, [raw])

  const load = useCallback(() => {
    if (!isTauriWebview()) {
      setItems(PREVIEW_FAVORITES)
      setApps(PREVIEW_APPS)
      setShortcutLabel(PREVIEW_CONFIG.global_shortcut)
      return
    }
    // 直接读磁盘最新数据，避免仅依赖启动快照导致跨机器/长驻进程不一致
    void invoke<FavoriteItem[]>('get_favorites_from_disk')
      .then((list) => setItems(list))
      .catch(console.error)
    void invoke<AppEntry[]>('list_installed_apps_cmd')
      .then((list) => setApps(list))
      .catch(console.error)
    void invoke<{ global_shortcut: string }>('get_app_config_cmd')
      .then((c) => setShortcutLabel(c.global_shortcut))
      .catch(() => {})
  }, [])

  /** 标题（含拼音/首字母）或 URL 含关键字即命中；标题命中的项排在仅 URL 命中的项之前，组内保持原列表顺序 */
  const filtered = useMemo(() => {
    const k = raw.trim().toLowerCase()
    if (k.length === 0) {
      return items
    }
    const titleHits: FavoriteItem[] = []
    const urlOnly: FavoriteItem[] = []
    for (const it of items) {
      const t = it.title.toLowerCase()
      const u = it.url.toLowerCase()
      if (t.includes(k) || pinyinMatch(t, k)) {
        titleHits.push(it)
      } else if (u.includes(k)) {
        urlOnly.push(it)
      }
    }
    return [...titleHits, ...urlOnly]
  }, [items, raw])

  /** 应用名前缀命中排在包含命中之前，最多展示 6 条，避免淹没收藏 */
  const appMatches = useMemo(() => {
    const k = raw.trim().toLowerCase()
    if (k.length === 0) {
      return []
    }
    const starts: AppEntry[] = []
    const incl: AppEntry[] = []
    for (const a of apps) {
      const m = nameMatch(a.name, k)
      if (m.fromStart) {
        starts.push(a)
      } else if (m.hit) {
        incl.push(a)
      }
    }
    return [...starts, ...incl].slice(0, 6)
  }, [apps, raw])

  /** 命中的本机应用惰性提取图标：Rust 侧有进程内缓存，会话内每个应用只请求一次 */
  const iconRequested = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!isTauriWebview()) {
      return
    }
    for (const a of appMatches) {
      if (iconRequested.current.has(a.target)) {
        continue
      }
      iconRequested.current.add(a.target)
      void invoke<string | null>('get_app_icon_cmd', { target: a.target })
        .then((uri) => {
          if (uri) {
            setAppIcons((m) => ({ ...m, [a.target]: uri }))
          }
        })
        .catch(console.error)
    }
  }, [appMatches])

  const trimmedRaw = raw.trim()
  /** 命令统一小写比较，避免大小写输入差异导致命令不生效 */
  const normalizedCommand = trimmedRaw.toLowerCase()
  /** `admin` 为最高优先级命令，命令态不展示书签与搜索 */
  const isAdminCommand = normalizedCommand === 'admin'
  const typing = trimmedRaw.length > 0
  const rawLooksUrl = typing && looksLikeUrl(trimmedRaw)

  const rows: PaletteRow[] = useMemo(() => {
    if (isAdminCommand) {
      return [
        {
          kind: 'cmd',
          title: '打开管理窗口',
          subtitle: '命令 admin · 新增、编辑、导入导出收藏',
        },
      ]
    }
    const r: PaletteRow[] = filtered.map((item) => ({ kind: 'fav' as const, item }))
    for (const a of appMatches) {
      r.push({ kind: 'app', name: a.name, target: a.target })
    }
    if (typing) {
      if (rawLooksUrl) {
        r.push({
          kind: 'web',
          url: normalizeUrl(trimmedRaw),
          title: '打开网址',
          subtitle: normalizeUrl(trimmedRaw),
        })
      } else {
        r.push({
          kind: 'web',
          url: `https://cn.bing.com/search?q=${encodeURIComponent(trimmedRaw)}`,
          title: `用必应搜索 “${trimmedRaw}”`,
          subtitle: `cn.bing.com/search?q=${trimmedRaw}`,
        })
      }
    }
    return r
  }, [filtered, appMatches, typing, rawLooksUrl, trimmedRaw, isAdminCommand])

  const selSafe = rows.length === 0 ? 0 : Math.min(sel, rows.length - 1)

  useEffect(() => {
    if (rows.length === 0) {
      return
    }
    if (sel >= rows.length) {
      setSel(rows.length - 1)
    }
  }, [rows.length, sel])

  /** 键盘预选时保证可见（鼠标 hover 也会触发，block: nearest 无副作用） */
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selSafe, rows.length])

  /** 关闭时清空输入与选中，并由后端隐藏 palette 窗口 */
  const hide = useCallback(async () => {
    setRaw('')
    setSel(0)
    if (!isTauriWebview()) {
      return
    }
    try {
      await invoke('hide_palette_cmd')
    } catch (e) {
      console.error(e)
      const w = getCurrentWindow()
      await w.hide().catch(() => {})
    }
  }, [])

  const tryOpen = useCallback(
    (url: string) => {
      void (async () => {
        try {
          if (isTauriWebview()) {
            await invoke('open_url_in_system_browser', { url })
          } else {
            // 纯浏览器预览：用新标签页打开
            window.open(url, '_blank', 'noopener,noreferrer')
          }
        } catch (e) {
          console.error(e)
        } finally {
          await hide()
        }
      })()
    },
    [hide],
  )

  const activateRow = useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) {
        return
      }
      if (row.kind === 'fav') {
        tryOpen(row.item.url)
      } else if (row.kind === 'app') {
        void (async () => {
          try {
            if (isTauriWebview()) {
              await invoke('launch_app_cmd', { target: row.target })
            }
          } catch (e) {
            console.error(e)
          } finally {
            await hide()
          }
        })()
      } else if (row.kind === 'web') {
        tryOpen(row.url)
      } else if (row.kind === 'cmd') {
        if (isTauriWebview()) {
          void invoke('show_admin_cmd').catch(console.error)
        } else {
          const next = new URL(window.location.href)
          next.searchParams.set('view', 'admin')
          window.location.assign(next.toString())
        }
        void hide().catch(console.error)
      }
    },
    [tryOpen, hide],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (rows.length > 0) {
        setSel((s) => {
          const cur = Math.min(s, rows.length - 1)
          return (cur + 1) % rows.length
        })
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length > 0) {
        setSel((s) => {
          const cur = Math.min(s, rows.length - 1)
          return (cur - 1 + rows.length) % rows.length
        })
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activateRow(rows[selSafe])
    }
  }

  useEffect(() => {
    void load()
    inputRef.current?.focus()
  }, [load])

  /** 与输入框内容同步，供 Escape 在 window 捕获阶段读取 */
  const rawRef = useRef(raw)
  rawRef.current = raw

  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      const r = rawRef.current
      if (r.length > 0) {
        setRaw('')
        return
      }
      void hide()
    }
    window.addEventListener('keydown', onWindowKeyDown, true)
    return () => window.removeEventListener('keydown', onWindowKeyDown, true)
  }, [hide])

  /** 失焦 = 点到其它窗口，关闭并清空；聚焦时保证可立即键入 */
  useEffect(() => {
    if (!isTauriWebview()) {
      return
    }
    const w = getCurrentWindow()
    let unlistenBlur: (() => void) | undefined
    let unlistenFocus: (() => void) | undefined
    /** 刚唤起时立刻 blur 会误关窗口，短暂忽略 */
    const blurGraceMs = 200
    const ignoreBlurUntil = { current: Date.now() + blurGraceMs }

    const focusInput = () => {
      window.setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
    }

    void w
      .listen('tauri://blur', () => {
        if (Date.now() < ignoreBlurUntil.current) {
          return
        }
        void hide()
      })
      .then((u) => {
        unlistenBlur = u
      })
      .catch(console.error)

    void w
      .listen('tauri://focus', () => {
        ignoreBlurUntil.current = Date.now() + blurGraceMs
        // 每次窗口被唤起都刷新一次书签与配置，保证命中最新数据
        load()
        setPopKey((k) => k + 1)
        focusInput()
      })
      .then((u) => {
        unlistenFocus = u
      })
      .catch(console.error)

    return () => {
      unlistenBlur?.()
      unlistenFocus?.()
    }
  }, [hide, load])

  /** 点在窗口内但不在搜索条/下拉上时关闭（仅靠 blur 无法覆盖窗内透明区） */
  const onBackdropPointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement | null
    if (!el) {
      void hide()
      return
    }
    if (el.closest('[data-palette-chrome]')) {
      return
    }
    void hide()
  }

  const shortcutChips = shortcutParts(shortcutLabel)

  return (
    <div
      className='fixed inset-0 box-border flex flex-col px-2 pb-3 pt-2'
      onPointerDown={onBackdropPointerDown}
    >
      <div
        key={popKey}
        data-palette-chrome=''
        className='palette-pop shrink-0 overflow-hidden rounded-2xl bg-ink-900/[0.985] shadow-2xl shadow-black/40 ring-1 ring-white/[0.08]'
      >
        {/* 搜索条 */}
        <div className='flex h-[54px] items-center gap-3 px-4'>
          <span aria-hidden className='h-2.5 w-2.5 shrink-0 rotate-45 rounded-[3px] bg-jade-400' />
          <input
            ref={inputRef}
            className='min-w-0 flex-1 border-0 bg-transparent text-[15px] text-fog-50 caret-jade-300 outline-none ring-0 placeholder:text-fog-600'
            value={raw}
            autoFocus
            spellCheck={false}
            onChange={(e) => setRaw(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          {shortcutChips.length > 0 ? (
            <div aria-hidden className='hidden shrink-0 items-center gap-1 sm:flex'>
              {shortcutChips.map((p) => (
                <kbd key={p} className='kbd-dark'>
                  {p}
                </kbd>
              ))}
            </div>
          ) : null}
        </div>

        {/* 命令态提示 */}
        {isAdminCommand ? (
          <div className='border-t border-white/[0.06] px-4 py-2 text-xs text-fog-500'>
            回车打开管理窗口，收藏在这里维护
          </div>
        ) : null}

        {/* 空收藏引导：还没加过任何收藏时给出方向 */}
        {!typing && items.length === 0 ? (
          <div className='border-t border-white/[0.06] px-4 py-4'>
            <div className='text-[13px] font-medium text-fog-300'>还没有收藏</div>
            <div className='mt-1 text-xs leading-relaxed text-fog-600'>
              输入 <span className='font-mono text-fog-400'>admin</span>{' '}
              并回车打开管理窗口，把常用网址加进来；也可以直接输入网址，或搜索本机已安装的应用。
            </div>
          </div>
        ) : null}

        {/* 候选列表：不用搜索词当 key，避免每次键入重挂载列表重放行动画而闪烁 */}
        {rows.length > 0 ? (
          <ul
            ref={listRef}
            data-palette-chrome=''
            className='palette-list max-h-[min(52vh,380px)] w-full shrink-0 overflow-y-auto overflow-x-hidden border-t border-white/[0.06] px-2 py-2 text-sm'
          >
            {rows.map((row, idx) => {
              const active = idx === selSafe
              const isSynthetic = row.kind !== 'fav'
              const prevIsFav = idx > 0 && rows[idx - 1].kind === 'fav'
              const rowTitle = row.kind === 'fav' ? row.item.title : row.kind === 'app' ? row.name : row.title
              const rowSub = row.kind === 'fav' ? row.item.url : row.kind === 'app' ? row.target : row.subtitle
              return (
                <li
                  key={
                    row.kind === 'fav'
                      ? `${row.item.addTime}__${row.item.title}__${row.item.url}`
                      : row.kind === 'app'
                        ? `app__${row.name}`
                        : row.kind
                  }
                  className={
                    isSynthetic && prevIsFav
                      ? 'mt-1.5 border-t border-white/[0.06] pt-1.5'
                      : 'mt-0.5 first:mt-0'
                  }
                >
                  <div
                    data-active={active || undefined}
                    role='button'
                    tabIndex={-1}
                    className={
                      'row-in flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition-colors duration-75 ' +
                      (active ? 'bg-ink-700' : 'hover:bg-ink-800/70')
                    }
                    onMouseEnter={() => setSel(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => activateRow(row)}
                  >
                    {row.kind === 'fav' ? (
                      <Seal
                        url={row.item.url}
                        title={row.item.title}
                        variant='dark'
                        className='h-8 w-8 rounded-[9px] text-[13px]'
                      />
                    ) : row.kind === 'app' ? (
                      appIcons[row.target] ? (
                        <img
                          src={appIcons[row.target]}
                          alt=''
                          aria-hidden
                          draggable={false}
                          className='h-8 w-8 shrink-0 rounded-[7px] object-contain'
                        />
                      ) : (
                        // 图标提取失败时的回退：与书签一致的首字母印章
                        <Seal
                          url={row.target}
                          title={row.name}
                          variant='dark'
                          className='h-8 w-8 rounded-[9px] text-[13px]'
                        />
                      )
                    ) : (
                      <span
                        aria-hidden
                        className={
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] ' +
                          (row.kind === 'cmd'
                            ? 'bg-jade-400/15 text-jade-300 ring-1 ring-jade-400/25'
                            : 'bg-white/[0.06] text-fog-400 ring-1 ring-white/[0.08]')
                        }
                      >
                        <svg
                          width='14'
                          height='14'
                          viewBox='0 0 24 24'
                          fill='none'
                          stroke='currentColor'
                          strokeWidth='2'
                          strokeLinecap='round'
                          strokeLinejoin='round'
                        >
                          {row.kind === 'cmd' ? (
                            <path d='M4 6h16M4 12h16M4 18h10' />
                          ) : rawLooksUrl ? (
                            <>
                              <path d='M15 3h6v6' />
                              <path d='M10 14 21 3' />
                              <path d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' />
                            </>
                          ) : (
                            <>
                              <circle cx='11' cy='11' r='7' />
                              <path d='m20 20-3.5-3.5' />
                            </>
                          )}
                        </svg>
                      </span>
                    )}
                    <div className='min-w-0 flex-1'>
                      <div className='truncate text-[13.5px] font-medium leading-5 text-fog-50'>{rowTitle}</div>
                      <div className='truncate font-mono text-[11px] leading-4 text-fog-500'>{rowSub}</div>
                    </div>
                    {active ? (
                      <kbd aria-hidden className='kbd-dark shrink-0'>
                        ↵
                      </kbd>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : null}

        {/* 键位提示条 */}
        {/* <div
          data-palette-chrome=''
          className='flex h-9 items-center justify-between gap-4 border-t border-white/[0.06] px-4'
        >
          <div className='flex min-w-0 items-center gap-3 text-[11px] text-fog-600'>
            {rows.length > 0 ? (
              <>
                <span className='flex items-center gap-1.5'>
                  <kbd className='kbd-dark'>↑↓</kbd>选择
                </span>
                <span className='flex items-center gap-1.5'>
                  <kbd className='kbd-dark'>↵</kbd>打开
                </span>
                <span className='flex items-center gap-1.5'>
                  <kbd className='kbd-dark'>esc</kbd>清空 / 关闭
                </span>
              </>
            ) : (
              <span>输入以搜索收藏或直达网址，admin 打开管理</span>
            )}
          </div>
          <div className='shrink-0 font-mono text-[11px] text-fog-600'>
            {items.length} 条收藏
          </div>
        </div> */}
      </div>
    </div>
  )
}
