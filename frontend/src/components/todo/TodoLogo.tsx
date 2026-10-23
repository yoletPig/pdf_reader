import styles from './TodoLogo.module.css'

/** 待办主题 Logo：靛紫渐变徽章 + 白色对勾（与全局主题一致，替代绿色 ✅） */
export function TodoLogo({ size = 22 }: { size?: number }) {
  return (
    <span
      className={styles.logo}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}
      aria-hidden
    >
      <svg
        width={size * 0.55}
        height={size * 0.55}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M2.5 8.5L6 12L13.5 4"
          stroke="white"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
