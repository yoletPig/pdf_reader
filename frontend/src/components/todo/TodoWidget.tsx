import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { todosApi, type TodoItem } from '../../api/todos'
import { TodoRow, todayStr } from './TodoRow'
import { TodoLogo } from './TodoLogo'
import styles from './TodoWidget.module.css'

const MAX_ITEMS = 5

/** 首页「今日待办」卡片：逾期/今日提醒 + 快速添加 + 快速勾选 */
export function TodoWidget() {
  const navigate = useNavigate()
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [draft, setDraft] = useState('')
  const [loaded, setLoaded] = useState(false)

  const fetchTodos = useCallback(async () => {
    try {
      const res = await todosApi.list({ status: 'pending' })
      setTodos(res.data.todos)
    } catch {
      /* 静默失败，不影响首页 */
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void fetchTodos()
  }, [fetchTodos])

  const today = todayStr()
  const overdue = todos.filter((t) => t.due_date && t.due_date < today)
  const todayList = todos.filter((t) => t.due_date === today)
  const attention = [...overdue, ...todayList]
  const shown = attention.length > 0 ? attention.slice(0, MAX_ITEMS) : todos.slice(0, MAX_ITEMS)

  const handleToggle = async (todo: TodoItem) => {
    setTodos((prev) => prev.filter((t) => t.id !== todo.id))
    try {
      await todosApi.update(todo.id, { status: 'done' })
    } catch {
      void fetchTodos()
    }
  }

  const handleQuickAdd = async () => {
    const title = draft.trim()
    if (!title) return
    setDraft('')
    try {
      await todosApi.create({ title, due_date: today })
      await fetchTodos()
    } catch {
      /* 静默 */
    }
  }

  return (
    <section className={styles.widget}>
      <header className={styles.head}>
        <TodoLogo size={20} />
        <span className={styles.title}>今日待办</span>
        {overdue.length > 0 && <span className={styles.alertChip}>⚠️ {overdue.length} 项逾期</span>}
        {todayList.length > 0 && <span className={styles.todayChip}>📅 今日 {todayList.length}</span>}
        <span className={styles.pendingChip}>待办 {todos.length}</span>
        <button className={styles.moreLink} onClick={() => navigate('/todos')}>
          查看全部 →
        </button>
      </header>

      <div className={styles.quickRow}>
        <input
          className={`input ${styles.quickInput}`}
          value={draft}
          placeholder="快速添加今日待办，Enter 确认…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleQuickAdd()
          }}
        />
        <button className="btn btn-primary btn-sm" onClick={handleQuickAdd} disabled={!draft.trim()}>
          添加
        </button>
      </div>

      <div className={styles.list}>
        {!loaded ? (
          <div className={styles.empty}>加载中…</div>
        ) : shown.length === 0 ? (
          <div className={styles.empty}>🎉 今日无待办提醒，享受轻松一刻</div>
        ) : (
          shown.map((todo) => (
            <TodoRow key={todo.id} todo={todo} onToggle={handleToggle} compact />
          ))
        )}
        {todos.length > shown.length && (
          <button className={styles.moreBtn} onClick={() => navigate('/todos')}>
            还有 {todos.length - shown.length} 项待办，去查看 →
          </button>
        )}
      </div>
    </section>
  )
}
