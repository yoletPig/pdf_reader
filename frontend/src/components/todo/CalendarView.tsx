import { useMemo, useState } from 'react'
import type { TodoItem } from '../../api/todos'
import { TodoRow, todayStr } from './TodoRow'
import styles from './CalendarView.module.css'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function toKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(base: Date, days: number) {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

interface CalendarViewProps {
  todos: TodoItem[]
  onToggle: (todo: TodoItem) => void
  onEdit: (todo: TodoItem) => void
  onDelete: (todo: TodoItem) => void
  onQuickAdd: (title: string, date: string) => void
}

/** 日历视图：月历网格 + 选中日的待办面板 */
export function CalendarView({ todos, onToggle, onEdit, onDelete, onQuickAdd }: CalendarViewProps) {
  const [monthCursor, setMonthCursor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [selectedDate, setSelectedDate] = useState(todayStr())
  const [draft, setDraft] = useState('')

  const byDate = useMemo(() => {
    const map = new Map<string, TodoItem[]>()
    for (const todo of todos) {
      if (!todo.due_date) continue
      const slot = map.get(todo.due_date)
      if (slot) slot.push(todo)
      else map.set(todo.due_date, [todo])
    }
    return map
  }, [todos])

  /** 6×7 网格（周一起始），含上下月补齐 */
  const cells = useMemo(() => {
    const first = new Date(monthCursor)
    const offset = (first.getDay() + 6) % 7 // 周一 = 0
    const start = addDays(first, -offset)
    return Array.from({ length: 42 }, (_, i) => addDays(start, i))
  }, [monthCursor])

  const today = todayStr()
  const monthLabel = `${monthCursor.getFullYear()} 年 ${monthCursor.getMonth() + 1} 月`
  const selectedTodos = byDate.get(selectedDate) || []
  const selectedLabel = new Date(`${selectedDate}T00:00:00`).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })

  const moveMonth = (delta: number) => {
    setMonthCursor((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }

  const handleQuickAdd = () => {
    const title = draft.trim()
    if (!title) return
    onQuickAdd(title, selectedDate)
    setDraft('')
  }

  return (
    <div className={styles.calendar}>
      <div className={styles.calHeader}>
        <button className={styles.navBtn} onClick={() => moveMonth(-1)} title="上个月">‹</button>
        <span className={styles.monthLabel}>{monthLabel}</span>
        <button className={styles.navBtn} onClick={() => moveMonth(1)} title="下个月">›</button>
        <button
          className={styles.todayBtn}
          onClick={() => {
            const now = new Date()
            setMonthCursor(new Date(now.getFullYear(), now.getMonth(), 1))
            setSelectedDate(todayStr())
          }}
        >
          今天
        </button>
      </div>

      <div className={styles.weekRow}>
        {WEEKDAYS.map((w) => (
          <div key={w} className={styles.weekCell}>{w}</div>
        ))}
      </div>

      <div className={styles.grid}>
        {cells.map((day) => {
          const key = toKey(day)
          const dayTodos = byDate.get(key) || []
          const doneTodos = dayTodos.filter((t) => t.status === 'done')
          const pending = dayTodos.length - doneTodos.length
          const inMonth = day.getMonth() === monthCursor.getMonth()
          return (
            <div
              key={key}
              className={[
                styles.dayCell,
                !inMonth ? styles.dayOut : '',
                key === today ? styles.dayToday : '',
                key === selectedDate ? styles.daySelected : '',
              ].join(' ')}
              onClick={() => setSelectedDate(key)}
            >
              <div className={styles.dayHead}>
                <span className={styles.dayNum}>{day.getDate()}</span>
                {dayTodos.length > 0 && (
                  <span className={`${styles.dayBadge} ${pending > 0 ? styles.dayBadgePending : styles.dayBadgeDone}`}>
                    {pending > 0 ? `${pending}` : `${doneTodos.length}✓`}
                  </span>
                )}
              </div>
              <div className={styles.dayChips}>
                {dayTodos.slice(0, 2).map((t) => (
                  <div
                    key={t.id}
                    className={`${styles.dayChip} ${t.status === 'done' ? styles.dayChipDone : ''}`}
                    title={t.title}
                  >
                    {t.title}
                  </div>
                ))}
                {dayTodos.length > 2 && <div className={styles.dayMore}>+{dayTodos.length - 2} 更多</div>}
              </div>
            </div>
          )
        })}
      </div>

      {/* 选中日面板 */}
      <div className={styles.dayPanel}>
        <div className={styles.dayPanelHead}>
          <span className={styles.dayPanelTitle}>{selectedLabel}</span>
          <span className={styles.dayPanelCount}>{selectedTodos.length} 项待办</span>
        </div>
        <div className={styles.quickAdd}>
          <input
            className={`input ${styles.quickInput}`}
            value={draft}
            placeholder={`在 ${selectedLabel} 添加待办…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleQuickAdd()
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={handleQuickAdd} disabled={!draft.trim()}>
            添加
          </button>
        </div>
        <div className={styles.dayList}>
          {selectedTodos.length === 0 ? (
            <div className={styles.dayEmpty}>这一天暂无待办</div>
          ) : (
            selectedTodos.map((todo) => (
              <TodoRow key={todo.id} todo={todo} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} compact />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
