/**
 * 「印章」：按书签 URL 的主机名确定性生成一枚彩色首字方块。
 * 同一网址永远同色，让候选列表可扫读；不依赖任何网络请求。
 */

/** 取 URL 主机名；解析失败时退回原始串 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** 主机名对应的色相（0-359） */
export function sealHue(url: string): number {
  return hashString(hostOf(url).toLowerCase()) % 360
}

/** 印章上展示的单字：优先取标题首字，退回主机名首字 */
export function sealGlyph(title: string, url: string): string {
  const t = title.trim()
  const source = t.length > 0 ? t : hostOf(url)
  const ch = Array.from(source)[0] ?? '·'
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch
}
