/**
 * 收件箱 · 消息中心：汇聚站内信（待办提醒 / 每日论文 / 系统消息）与邮件。
 * 用于待办页「收件箱」视图。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { notificationsApi, type NotificationItem } from '../../api/notifications'
import { MsgTypeIcon } from '../icons/InboxIcons'
import { Segmented, useToast } from '../ui/kit'
import styles from './InboxCenter.module.css'

type ChannelFilter = 'all' | 'inapp' | 'email'

const CHANNEL_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'inapp', label: '📨 站内信' },
  { value: 'email', label: '📧 邮件' },
] as const

const TYPE_LABELS: Record<string, string> = {
  todo: '待办提醒',
  papers: '每日论文',
  system: '系统消息',
  email: '邮件',
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

export function InboxCenter({ onUnreadChange }: { onUnreadChange?: (unread: number) => void }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [channel, setChannel] = useState<ChannelFilter>('all')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await notificationsApi.list({ limit: 100 })
      setItems(res.data.notifications)
      setUnread(res.data.unread_count)
      onUnreadChange?.(res.data.unread_count)
    } catch {
      /* 静默 */
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    if (channel === 'email') return items.filter((n) => n.type === 'email')
    if (channel === 'inapp') return items.filter((n) => n.type !== 'email')
    return items
  }, [items, channel])

  const handleClickItem = async (item: NotificationItem) => {
    if (!item.read) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)))
      const next = Math.max(0, unread - 1)
      setUnread(next)
      onUnreadChange?.(next)
      try {
        await notificationsApi.markRead(item.id)
      } catch {
        /* 静默 */
      }
    }
    if (item.link) navigate(item.link)
  }

  const handleReadAll = async () => {
    try {
      await notificationsApi.markAllRead()
      await load()
      toast.success('已全部标为已读')
    } catch {
      toast.error('操作失败')
    }
  }

  const handleClearRead = async () => {
    try {
      const res = await notificationsApi.clearRead()
      await load()
      toast.success(res.data.cleared > 0 ? `已清空 ${res.data.cleared} 条已读消息` : '没有已读消息可清空')
    } catch {
      toast.error('清空失败')
    }
  }

  const handleDelete = async (item: NotificationItem) => {
    setItems((prev) => prev.filter((n) => n.id !== item.id))
    if (!item.read) {
      const next = Math.max(0, unread - 1)
      setUnread(next)
      onUnreadChange?.(next)
    }
    try {
      await notificationsApi.delete(item.id)
    } catch {
      toast.error('删除失败')
      void load()
    }
  }

  return (
    <section className={styles.center}>
      <div className={styles.toolbar}>
        <Segmented options={[...CHANNEL_OPTIONS]} value={channel} onChange={setChannel} size="sm" />
        <div className={styles.actions}>
          <button className="btn btn-ghost btn-sm" onClick={handleReadAll} disabled={unread === 0}>
            ✓ 全部已读
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleClearRead}>
            🧹 清空已读
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.empty}>
          <div className="spinner" />
          <span>正在加载消息…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.empty}>
          {channel === 'email' ? (
            <>
              <div className={styles.emptyIcon}>📧</div>
              <p className={styles.emptyTitle}>暂无邮件</p>
              <p className={styles.emptyDesc}>邮箱通道接入后，外部邮件将自动汇聚到这里</p>
            </>
          ) : (
            <>
              <div className={styles.emptyIcon}>🎉</div>
              <p className={styles.emptyTitle}>暂无消息</p>
              <p className={styles.emptyDesc}>待办提醒、每日论文等站内消息都会出现在这里</p>
            </>
          )}
        </div>
      ) : (
        <div className={styles.list}>
          {filtered.map((item) => (
            <div
              key={item.id}
              className={`${styles.item} ${item.read ? styles.itemRead : styles.itemUnread}`}
              onClick={() => handleClickItem(item)}
            >
              <MsgTypeIcon type={item.type} size={32} />
              <div className={styles.itemBody}>
                <div className={styles.itemTitle}>
                  {!item.read && <span className={styles.dot} />}
                  <span className={styles.titleText}>{item.title}</span>
                  <span className={styles.typeTag}>{TYPE_LABELS[item.type] || '消息'}</span>
                </div>
                {item.body ? <div className={styles.itemText}>{item.body}</div> : null}
                <div className={styles.itemTime}>
                  {timeAgo(item.created_at)}
                  {item.link ? <span className={styles.linkHint}> · 点击查看详情 →</span> : null}
                </div>
              </div>
              <button
                className={styles.deleteBtn}
                title="删除这条消息"
                onClick={(e) => {
                  e.stopPropagation()
                  void handleDelete(item)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
