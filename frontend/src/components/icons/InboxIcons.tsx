/**
 * 收件箱 / 消息图标（主题渐变徽章风格，与 TodoLogo 一致，替代 emoji）
 */
import styles from './InboxIcons.module.css'

interface IconProps {
  size?: number
  className?: string
}

/** 收件箱托盘（描边式，颜色跟随 currentColor） */
export function IconInboxTray({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        d="M22 12h-6l-2 3h-4l-2-3H2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 消息类型白色字形（16x16，绘制于渐变徽章内） */
function TypeGlyph({ type }: { type: string }) {
  const stroke = { stroke: 'white', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (type === 'todo') {
    return <path d="M2.8 8.4L6.2 11.8L13.2 4.2" {...stroke} strokeWidth={2.1} />
  }
  if (type === 'papers') {
    return (
      <g {...stroke}>
        <path d="M4 2.6h5L12.2 6v7.4a1 1 0 0 1-1 1H4.9a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z" />
        <path d="M8.8 2.9v3.2h3.1" strokeWidth={1.4} />
        <path d="M6.2 9h3.8M6.2 11.3h2.4" strokeWidth={1.4} />
      </g>
    )
  }
  if (type === 'email') {
    return (
      <g {...stroke}>
        <rect x="2.4" y="3.8" width="11.2" height="8.4" rx="1.3" />
        <path d="M3.2 5.1 8 8.6l4.8-3.5" strokeWidth={1.4} />
      </g>
    )
  }
  // system / 默认：铃铛
  return (
    <g {...stroke}>
      <path d="M8 2.3c-1.85 0-3.35 1.5-3.35 3.35 0 2.9-1.05 3.75-1.05 3.75h8.8s-1.05-.85-1.05-3.75C11.35 3.8 9.85 2.3 8 2.3z" />
      <path d="M6.75 11.7a1.35 1.35 0 0 0 2.5 0" strokeWidth={1.5} />
    </g>
  )
}

/** 消息类型图标：靛紫渐变圆角徽章 + 白色字形 */
export function MsgTypeIcon({ type, size = 26 }: { type: string; size?: number }) {
  return (
    <span
      className={styles.badge}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      aria-hidden
    >
      <svg
        width={size * 0.56}
        height={size * 0.56}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <TypeGlyph type={type} />
      </svg>
    </span>
  )
}
