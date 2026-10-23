import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { foldersApi, type FolderItem, type TagCount } from '../../api/folders'
import { TodoWidget } from '../../components/todo/TodoWidget'
import { DailyPapers } from '../../components/daily-papers/DailyPapers'
import { InboxBell } from '../../components/ui/InboxBell'
import { ThemeToggle } from '../../components/ui/kit'
import {
  IconLibrary,
  IconUngrouped,
  IconChat,
  IconNotes,
  IconTodo,
} from '../../components/icons/NavIcons'
import styles from './DashboardPage.module.css'

const NAV_ITEMS = [
  { icon: <IconLibrary size={17} />, label: '全部论文', to: '/library' },
  { icon: <IconUngrouped size={17} />, label: '未分组', to: '/library?f=uncategorized' },
  { icon: <IconChat size={17} />, label: 'AI 对话', to: '/chat' },
  { icon: <IconNotes size={17} />, label: '笔记', to: '/notes' },
  { icon: <IconTodo size={17} />, label: '待办', to: '/todos' },
  { icon: '⚙️', label: '系统设置', to: '/settings' },
]

const QUICK_LINKS = [
  { icon: <IconLibrary size={22} />, label: '论文库', desc: '管理我的文献', to: '/library' },
  { icon: <IconChat size={22} />, label: 'AI 对话', desc: '论文阅读助手', to: '/chat' },
  { icon: <IconNotes size={22} />, label: '笔记', desc: 'Markdown 笔记本', to: '/notes' },
  { icon: <IconTodo size={22} />, label: '待办', desc: '任务与日历', to: '/todos' },
]

function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function dateLabel() {
  return new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

/** 新首页：左侧栏导航 + 右侧内容（今日待办 / 快捷入口 / 每日论文） */
export default function DashboardPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [tags, setTags] = useState<TagCount[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const [foldersRes, tagsRes] = await Promise.all([foldersApi.list(), foldersApi.allTags()])
        setFolders(foldersRes.data.folders || [])
        setTags(tagsRes.data.tags || [])
      } catch {
        /* 静默 */
      }
    })()
  }, [])

  // 支持 /#papers 锚点直达每日论文区
  useEffect(() => {
    if (location.hash === '#papers') {
      document.getElementById('papers')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [location.hash])

  return (
    <div className={styles.container}>
      {/* ======== 侧边栏 ======== */}
      <aside className={styles.sidebar}>
        <div className={styles.brand} onClick={() => navigate('/library')}>
          <span className={styles.brandIcon}>📜</span>
          <span className={styles.brandName}>Papers</span>
        </div>

        <nav className={styles.navSection}>
          <button className={`${styles.navItem} ${styles.navActive}`}>
            <span className={styles.navIcon}>🏠</span>
            <span className={styles.navLabel}>首页</span>
          </button>
          {NAV_ITEMS.map((item) => (
            <button key={item.to + item.label} className={styles.navItem} onClick={() => navigate(item.to)}>
              <span className={styles.navIcon}>{item.icon}</span>
              <span className={styles.navLabel}>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className={styles.sectionHeader}>
          <span>文件夹</span>
        </div>
        <div className={styles.folderList}>
          {folders.length === 0 ? (
            <div className={styles.sidebarEmpty}>暂无文件夹</div>
          ) : (
            folders.map((folder) => (
              <button
                key={folder.id}
                className={styles.navItem}
                onClick={() => navigate(`/library?f=${folder.id}`)}
              >
                <span className={styles.navIcon}>📁</span>
                <span className={styles.navLabel}>{folder.name}</span>
                <span className={styles.navCount}>{folder.paper_count}</span>
              </button>
            ))
          )}
        </div>

        <div className={styles.sectionHeader}>
          <span>标签</span>
        </div>
        <div className={styles.tagCloud}>
          {tags.length === 0 ? (
            <div className={styles.sidebarEmpty}>暂无标签</div>
          ) : (
            tags.map((tag) => (
              <button
                key={tag.name}
                className={styles.tagChip}
                onClick={() => navigate(`/library?t=${encodeURIComponent(tag.name)}`)}
              >
                {tag.name} <em>{tag.count}</em>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* ======== 右侧内容 ======== */}
      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.greetingWrap}>
            <h1 className={styles.greeting}>{greeting()} 👋</h1>
            <span className={styles.dateText}>{dateLabel()} · 今天也要高效阅读呀</span>
          </div>
          <div className={styles.topActions}>
            <InboxBell />
            <ThemeToggle />
          </div>
        </header>

        <div className={styles.content}>
          <div className={styles.layout}>
            <div className={styles.sideCol}>
              <TodoWidget />
              <section className={styles.quickCard}>
                <h2 className={styles.quickTitle}>⚡ 快捷入口</h2>
                <div className={styles.quickGrid}>
                  {QUICK_LINKS.map((item) => (
                    <button key={item.to} className={styles.quickItem} onClick={() => navigate(item.to)}>
                      <span className={styles.quickIcon}>{item.icon}</span>
                      <span className={styles.quickLabel}>{item.label}</span>
                      <span className={styles.quickDesc}>{item.desc}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <div className={styles.mainCol} id="papers">
              <DailyPapers />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
