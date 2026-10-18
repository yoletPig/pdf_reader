/**
 * 全局 Toast 通知 + 确认弹窗 + 分段控制器 + 图片灯箱
 * 现代极简设计，与全局设计 token 联动。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import styles from './kit.module.css'

/* ============================================================
   Toast
   ============================================================ */

type ToastType = 'success' | 'error' | 'info' | 'warning'

interface ToastItem {
  id: number
  type: ToastType
  message: string
}

interface ToastApi {
  show: (message: string, type?: ToastType) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
  warning: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const TOAST_ICON: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++counter.current
    setToasts((prev) => [...prev.slice(-4), { id, type, message }])
    window.setTimeout(() => dismiss(id), type === 'error' ? 5000 : 3200)
  }, [dismiss])

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (m) => show(m, 'success'),
    error: (m) => show(m, 'error'),
    info: (m) => show(m, 'info'),
    warning: (m) => show(m, 'warning'),
  }), [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.toastWrap}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`${styles.toast} ${styles[toast.type]}`}
            onClick={() => dismiss(toast.id)}
            role="status"
          >
            <span className={styles.toastIcon}>{TOAST_ICON[toast.type]}</span>
            <span className={styles.toastMessage}>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // 未包裹 Provider 时降级为 console
    return {
      show: (m) => console.log('[toast]', m),
      success: (m) => console.log('[toast:ok]', m),
      error: (m) => console.error('[toast:err]', m),
      info: (m) => console.log('[toast:info]', m),
      warning: (m) => console.warn('[toast:warn]', m),
    }
  }
  return ctx
}

/* ============================================================
   Segmented 分段控制器
   ============================================================ */

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  title?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className={`${styles.segmented} ${size === 'sm' ? styles.segmentedSm : ''}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          title={opt.title}
          className={`${styles.segmentItem} ${value === opt.value ? styles.segmentActive : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/* ============================================================
   Modal（确认 / 自定义内容）
   ============================================================ */

export function Modal({
  open,
  title,
  children,
  onClose,
  footer,
  width = 440,
}: {
  open: boolean
  title?: ReactNode
  children?: ReactNode
  onClose: () => void
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className={styles.modalOverlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} style={{ width }} role="dialog">
        {title != null && (
          <div className={styles.modalHeader}>
            <h3 className={styles.modalTitle}>{title}</h3>
            <button className={styles.modalClose} onClick={onClose} aria-label="关闭">✕</button>
          </div>
        )}
        <div className={styles.modalBody}>{children}</div>
        {footer && <div className={styles.modalFooter}>{footer}</div>}
      </div>
    </div>
  )
}

/** 便捷确认框（受控） */
export function ConfirmDialog({
  open,
  title = '确认操作',
  message,
  confirmText = '确认',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title?: string
  message: ReactNode
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={400}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel}>取消</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </>
      }
    >
      <div className={styles.confirmMessage}>{message}</div>
    </Modal>
  )
}

/* ============================================================
   Lightbox 图片灯箱（缩放 / 拖拽 / 旋转）
   ============================================================ */

export function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string
  alt?: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '+' || e.key === '=') setScale((s) => Math.min(s * 1.25, 6))
      if (e.key === '-') setScale((s) => Math.max(s / 1.25, 0.3))
      if (e.key === '0') { setScale(1); setRotation(0); setOffset({ x: 0, y: 0 }) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    setOffset({
      x: drag.baseX + (e.clientX - drag.startX),
      y: drag.baseY + (e.clientY - drag.startY),
    })
  }
  const onPointerUp = () => {
    dragRef.current = null
  }

  return (
    <div className={styles.lightboxOverlay} onClick={onClose}>
      <div className={styles.lightboxToolbar} onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-icon" title="缩小 (-)" onClick={() => setScale((s) => Math.max(s / 1.25, 0.3))}>−</button>
        <span className={styles.lightboxZoomLabel}>{Math.round(scale * 100)}%</span>
        <button className="btn btn-icon" title="放大 (+)" onClick={() => setScale((s) => Math.min(s * 1.25, 6))}>＋</button>
        <button className="btn btn-icon" title="旋转" onClick={() => setRotation((r) => (r + 90) % 360)}>↻</button>
        <button className="btn btn-icon" title="重置 (0)" onClick={() => { setScale(1); setRotation(0); setOffset({ x: 0, y: 0 }) }}>⤢</button>
        <button className="btn btn-icon" title="关闭 (Esc)" onClick={onClose}>✕</button>
      </div>
      <img
        src={src}
        alt={alt}
        className={styles.lightboxImage}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`,
          cursor: dragRef.current ? 'grabbing' : 'grab',
        }}
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(e) => {
          setScale((s) => Math.min(Math.max(s * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3), 6))
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

/** 可放大的图片（点击打开灯箱） */
export function ZoomableImage({
  src,
  alt,
  style: inlineStyle,
}: {
  src: string
  alt?: string
  style?: React.CSSProperties
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <img
        src={src}
        alt={alt}
        style={{ cursor: 'zoom-in', ...inlineStyle }}
        onClick={() => setOpen(true)}
        draggable={false}
      />
      {open && <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  )
}

/* ============================================================
   ThemeToggle 主题切换
   ============================================================ */

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<string>(
    () => document.documentElement.getAttribute('data-theme') || 'light',
  )
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    window.localStorage.setItem('pdf-reader-theme', next)
    setTheme(next)
  }
  return (
    <button
      className={`btn btn-icon ${className || ''}`}
      title={theme === 'dark' ? '切换浅色' : '切换深色'}
      onClick={toggle}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  )
}
