import { sealGlyph, sealHue } from '../utils/seal'

/**
 * 「印章」：按网址域名确定性配色的首字方块。
 * 同一网址永远同色，是整个界面里承担扫读功能的彩色元素。
 */
export function Seal({
  url,
  title,
  variant,
  className,
}: {
  url: string
  title: string
  variant: 'dark' | 'light'
  className: string
}) {
  const hue = sealHue(url)
  const style =
    variant === 'dark'
      ? {
          background: `hsl(${hue} 42% 25%)`,
          color: `hsl(${hue} 64% 76%)`,
          boxShadow: `inset 0 0 0 1px hsl(${hue} 46% 42% / 0.55)`,
        }
      : {
          background: `hsl(${hue} 55% 95%)`,
          color: `hsl(${hue} 42% 32%)`,
          boxShadow: `inset 0 0 0 1px hsl(${hue} 42% 84%)`,
        }
  return (
    <span
      aria-hidden
      style={style}
      className={'flex shrink-0 select-none items-center justify-center font-semibold ' + className}
    >
      {sealGlyph(title, url)}
    </span>
  )
}
