import { useEffect, useState } from 'react'
import { AdminRoot } from './admin/AdminView'
import { PaletteView } from './palette/PaletteView'
import { resolveTauriWindowLabel } from './utils/resolveTauriWindowLabel'

/**
 * 按 Tauri 窗口 label 分支渲染
 */
export function AppRoot() {
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    // 在浏览器中勿直接调用 getCurrentWindow()，会访问不存在的 __TAURI_INTERNALS__
    setLabel(resolveTauriWindowLabel())
  }, [])

  if (label == null) {
    return <div className='p-3 text-stone-600'>加载中…</div>
  }
  if (label === 'palette') {
    return <PaletteView />
  }
  if (label === 'admin') {
    return (
      <div className='h-full min-h-0'>
        <AdminRoot />
      </div>
    )
  }
  return <div className='p-3'>未知窗口：{label}</div>
}
