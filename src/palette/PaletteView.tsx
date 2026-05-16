import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FavoriteItem } from '../types/favorite'
import { isTauriWebview } from '../utils/tauriEnv'

type PaletteRow = { kind: 'fav'; item: FavoriteItem } | { kind: 'bing' }

/**
 * 速开：紧凑置顶窗口（无全屏蒙层），失焦即关；输入框 + 收藏过滤 + 必应快捷项
 */
export function PaletteView() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [raw, setRaw] = useState('')
  const [filterKey, setFilterKey] = useState('')

  const [items, setItems] = useState<FavoriteItem[]>([])
  const [sel, setSel] = useState(0)

  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilterKey(raw)
    }, 100)
    return () => window.clearTimeout(t)
  }, [raw])

  useEffect(() => {
    // 过滤关键词变化时，预选回到第一条
    setSel(0)
  }, [filterKey])

  const load = useCallback(() => {
    // 浏览器直连 Vite 时无 Rust 侧 command，不能调用 invoke
    if (!isTauriWebview()) {
      setItems([])
      return
    }
    void invoke<FavoriteItem[]>('get_favorites_snapshot')
      .then((list) => setItems(list))
      .catch(console.error)
  }, [])

  /** 标题或 URL 含关键字即命中；标题命中的项排在仅 URL 命中的项之前，组内保持原列表顺序 */
  const filtered = useMemo(() => {
    const k = filterKey.trim().toLowerCase()
    if (k.length === 0) {
      return items
    }
    const titleHits: FavoriteItem[] = []
    const urlOnly: FavoriteItem[] = []
    for (const it of items) {
      const t = it.title.toLowerCase()
      const u = it.url.toLowerCase()
      if (t.includes(k)) {
        titleHits.push(it)
      } else if (u.includes(k)) {
        urlOnly.push(it)
      }
    }
    return [...titleHits, ...urlOnly]
  }, [items, filterKey])

  /** 有输入且非内置命令时，列表底部固定展示「必应搜索」 */
  const trimmedRaw = raw.trim()
  const showBingRow = trimmedRaw.length > 0 && trimmedRaw !== '/admin' && trimmedRaw !== '/reload'

  const rows: PaletteRow[] = useMemo(() => {
    if (!showBingRow) {
      return []
    }
    const r: PaletteRow[] = filtered.map((item) => ({ kind: 'fav' as const, item }))
    r.push({ kind: 'bing' })
    return r
  }, [filtered, showBingRow])

  const selSafe = rows.length === 0 ? 0 : Math.min(sel, rows.length - 1)

  useEffect(() => {
    if (rows.length === 0) {
      return
    }
    if (sel >= rows.length) {
      setSel(rows.length - 1)
    }
  }, [rows.length, sel])

  /** 关闭时清空输入与选中，并由后端隐藏 palette 窗口 */
  const hide = useCallback(async () => {
    setRaw('')
    setFilterKey('')
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

  const openBingForCurrentInput = useCallback(() => {
    const q = raw.trim()
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}`
    tryOpen(url)
  }, [raw, tryOpen])

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
      const t = raw.trim()
      if (t === '/admin') {
        if (isTauriWebview()) {
          void invoke('show_admin_cmd')
          void hide().catch(console.error)
        } else {
          // 与 AppRoot 的 `?view=admin` 约定一致，整页切到管理页
          const next = new URL(window.location.href)
          next.searchParams.set('view', 'admin')
          window.location.assign(next.toString())
        }
        return
      }
      if (t === '/reload') {
        if (isTauriWebview()) {
          void invoke('relaunch_app')
        } else {
          window.location.reload()
        }
        return
      }
      if (rows.length > 0) {
        const row = rows[selSafe]
        if (row?.kind === 'fav') {
          tryOpen(row.item.url)
        } else if (row?.kind === 'bing') {
          openBingForCurrentInput()
        }
      }
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
  }, [hide])

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

  return (
    <div
      className='fixed inset-0 box-border flex flex-col px-2 pb-3 pt-2'
      onPointerDown={onBackdropPointerDown}
    >
      <div
        data-palette-chrome=''
        className='shrink-0 overflow-hidden rounded-xl bg-stone-200/95 text-stone-900 shadow-sm ring-1 ring-stone-300/50'
      >
        <div className='flex h-12 items-stretch'>
          <input
            ref={inputRef}
            className='min-w-0 flex-1 border-0 bg-transparent px-3 text-sm outline-none ring-0'
            value={raw}
            autoFocus
            onChange={(e) => setRaw(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        {raw.trim() === '/admin' || raw.trim() === '/reload' ? (
          <div className='border-t border-stone-300/60 px-3 py-2 text-xs text-stone-500'>
            回车以执行：{raw.trim()}
          </div>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <ul
          data-palette-chrome=''
          className='mt-1 max-h-[min(60vh,420px)] w-full shrink-0 overflow-y-auto overflow-x-hidden rounded-xl bg-stone-200/90 py-1 text-sm shadow ring-1 ring-stone-300/50'
        >
          {rows.map((row, idx) => {
            const active = idx === selSafe
            if (row.kind === 'fav') {
              const it = row.item
              const rowKey = `${it.addTime}__${it.title}__${it.url}`
              return (
                <li
                  key={rowKey}
                  className={
                    'cursor-pointer px-3 py-2 ' +
                    (active ? 'bg-stone-400/80' : 'hover:bg-stone-300/60')
                  }
                  onMouseEnter={() => setSel(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => tryOpen(it.url)}
                >
                  <div className='truncate font-medium'>{it.title}</div>
                  <div className='truncate text-xs text-stone-600'>{it.url}</div>
                </li>
              )
            }
            return (
              <li
                key='bing-search-synthetic'
                className={
                  'cursor-pointer px-3 py-2 ' +
                  (active ? 'bg-stone-400/80' : 'hover:bg-stone-300/60')
                }
                onMouseEnter={() => setSel(idx)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => openBingForCurrentInput()}
              >
                <div className='truncate font-medium'>必应搜索</div>
                <div className='truncate text-xs text-stone-600'>
                  https://cn.bing.com/search?q={encodeURIComponent(trimmedRaw)}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
