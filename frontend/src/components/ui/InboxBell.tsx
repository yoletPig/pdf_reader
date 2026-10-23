import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { notificationsApi, type NotificationItem } from '../../api/notifications'
import styles from './InboxBell.module.css'

const TYPE_ICONS: Record<string, string> = {
  todo: '✅',
  papers: '📚',
  system: '🔔',
}

function timeAgo(iso: string) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days} 天前` : new Date(iso).toLocaleDateString()
}

/**
 * 全局收件箱铃铛：悬停展开消息列表，带未读角标，支持一键全读。
 * 放置在各页面右上角。
 */
export function InboxBell() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const closeTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await notificationsApi.list({ limit: 12 })
      setItems(res.data.notifications)
      setUnread(res.data.unread_count)
    } catch {
      /* 静默 */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const handleEnter = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setOpen(true)
    void refresh()
  }

  const handleLeave = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 250)
  }

  const handleClickItem = async (item: NotificationItem) => {
    if (!item.read) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)))
      setUnread((u) => Math.max(0, u - 1))
      try {
        await notificationsApi.markRead(item.id)
      } catch {
        /* 静默 */
      }
    }
    setOpen(false)
    if (item.link) navigate(item.link)
  }

  const handleReadAll = async () => {
    try {
      await notificationsApi.markAllRead()
      await refresh()
    } catch {
      /* 静默 */
    }
  }

  const handleClearRead = async () => {
    try {
      await notificationsApi.clearRead()
      await refresh()
    } catch {
      /* 静默 */
    }
  }

  return (
    <div className={styles.wrap} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button className={styles.bell} title="收件箱" onClick={() => setOpen((o) => !o)}>
        <span className={styles.bellIcon}>🔔</span>
        {unread > 0 && <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className={styles.popover}>
          <div className={styles.popHead}>
            <span className={styles.popTitle}>收件箱</span>
            {unread > 0 && <span className={styles.unreadChip}>{unread} 条未读</span>}
            <div className={styles.popActions}>
              <button className={styles.popAction} onClick={handleReadAll} title="一键全部标为已读">
                ✓ 全部已读
              </button>
              <button className={styles.popAction} onClick={handleClearRead} title="清空已读消息">
                清空
              </button>
            </div>
          </div>

          <div className={styles.list}>
            {items.length === 0 ? (
              <div className={styles.empty}>🎉 暂无消息</div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`${styles.item} ${item.read ? styles.itemRead : styles.itemUnread}`}
                  onClick={() => handleClickItem(item)}
                >
                  <span className={styles.itemIcon}>{TYPE_ICONS[item.type] || '🔔'}</span>
                  <div className={styles.itemBody}>
                    <div className={styles.itemTitle}>
                      {!item.read && <span className={styles.dot} />}
                      {item.title}
                    </div>
                    {item.body ? <div className={styles.itemText}>{item.body}</div> : null}
                    <div className={styles.itemTime}>{timeAgo(item.created_at)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
