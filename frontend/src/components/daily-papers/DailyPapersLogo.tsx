import styles from './DailyPapersLogo.module.css'

/** 每日论文 Logo：靛紫渐变徽章 + 白色报刊字形（与全局主题一致） */
export function DailyPapersLogo({ size = 22 }: { size?: number }) {
  return (
    <span
      className={styles.logo}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}
      aria-hidden
    >
      <svg
        width={size * 0.6}
        height={size * 0.6}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          x="2.3"
          y="3.2"
          width="11.4"
          height="9.6"
          rx="1.4"
          stroke="white"
          strokeWidth="1.6"
        />
        <rect x="4.3" y="5.3" width="3.6" height="3.2" rx="0.6" stroke="white" strokeWidth="1.15" />
        <path
          d="M9.5 5.6h2.5M9.5 7.4h2.5M4.3 10.7h7.7"
          stroke="white"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}
