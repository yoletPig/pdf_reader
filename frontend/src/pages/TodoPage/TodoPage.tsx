import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { todosApi, type TodoItem, type TodoPriority } from '../../api/todos'
import { ConfirmDialog, Modal, Segmented, useToast } from '../../components/ui/kit'
import styles from './TodoPage.module.css'

type FilterKey = 'all' | 'pending' | 'done'

const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待办' },
  { value: 'done', label: '已完成' },
] as const

const PRIORITY_LABELS: Record<TodoPriority, string> = { low: '低', medium: '中', high: '高' }

const PRIORITY_OPTIONS = [
  { value: 'low', label: '低优先级' },
  { value: 'medium', label: '中优先级' },
  { value: 'high', label: '高优先级' },
]

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDate(due: string) {
  if (!due) return ''
  const today = todayStr()
  if (due === today) return '今天'
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  if (due === tomorrowStr) return '明天'
  return due.slice(5).replace('-', '/')
}

interface Bucket {
  key: string
  label: string
  items: TodoItem[]
}

export default function TodoPage() {
  const navigate = useNavigate()
  const toast = useToast()

  const [todos, setTodos] = useState<TodoItem[]>([])
  const [counts, setCounts] = useState({ total: 0, pending: 0, done: 0 })
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)

  // 快速添加
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('medium')
  const [dueDate, setDueDate] = useState('')
  const [adding, setAdding] = useState(false)

  // 编辑弹窗
  const [editing, setEditing] = useState<TodoItem | null>(null)
  const [draft, setDraft] = useState({ title: '', description: '', priority: 'medium' as TodoPriority, due_date: '' })
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TodoItem | null>(null)

  const fetchTodos = async () => {
    try {
      const res = await todosApi.list({ status: filter, q: query })
      setTodos(res.data.todos)
      setCounts({
        total: res.data.total_count,
        pending: res.data.pending_count,
        done: res.data.done_count,
      })
    } catch {
      toast.error('加载待办失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(fetchTodos, query ? 250 : 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, query])

  const handleAdd = async () => {
    const t = title.trim()
    if (!t || adding) return
    setAdding(true)
    try {
      await todosApi.create({ title: t, priority, due_date: dueDate })
      setTitle('')
      setDueDate('')
      toast.success('已添加待办')
      await fetchTodos()
    } catch {
      toast.error('添加失败')
    } finally {
      setAdding(false)
    }
  }

  const toggleTodo = async (todo: TodoItem) => {
    const next = todo.status === 'done' ? 'pending' : 'done'
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, status: next } : t)))
    try {
      await todosApi.update(todo.id, { status: next })
      await fetchTodos()
    } catch {
      toast.error('更新失败')
      await fetchTodos()
    }
  }

  const openEdit = (todo: TodoItem) => {
    setEditing(todo)
    setDraft({
      title: todo.title,
      description: todo.description,
      priority: todo.priority,
      due_date: todo.due_date,
    })
  }

  const handleSave = async () => {
    if (!editing) return
    if (!draft.title.trim()) {
      toast.error('标题不能为空')
      return
    }
    setSaving(true)
    try {
      await todosApi.update(editing.id, {
        title: draft.title.trim(),
        description: draft.description,
        priority: draft.priority,
        due_date: draft.due_date,
      })
      setEditing(null)
      toast.success('已保存')
      await fetchTodos()
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await todosApi.delete(deleteTarget.id)
      setDeleteTarget(null)
      toast.success('已删除')
      await fetchTodos()
    } catch {
      toast.error('删除失败')
    }
  }

  /** 按截止日期分组：已逾期 / 今天 / 未来 / 无期限 */
  const buckets = useMemo<Bucket[]>(() => {
    const today = todayStr()
    const overdue: TodoItem[] = []
    const todayList: TodoItem[] = []
    const upcoming: TodoItem[] = []
    const someday: TodoItem[] = []
    for (const todo of todos) {
      if (todo.status === 'done') continue
      if (!todo.due_date) someday.push(todo)
      else if (todo.due_date < today) overdue.push(todo)
      else if (todo.due_date === today) todayList.push(todo)
      else upcoming.push(todo)
    }
    return [
      { key: 'overdue', label: '已逾期', items: overdue },
      { key: 'today', label: '今天', items: todayList },
      { key: 'upcoming', label: '未来', items: upcoming },
      { key: 'someday', label: '无期限', items: someday },
    ].filter((b) => b.items.length > 0)
  }, [todos])

  const doneList = useMemo(() => todos.filter((t) => t.status === 'done'), [todos])

  const renderTodo = (todo: TodoItem) => (
    <div key={todo.id} className={`${styles.todoItem} ${todo.status === 'done' ? styles.todoDone : ''}`}>
      <button
        className={styles.checkbox}
        title={todo.status === 'done' ? '标记为待办' : '标记为完成'}
        onClick={() => toggleTodo(todo)}
      >
        {todo.status === 'done' ? '✓' : ''}
      </button>
      <div className={styles.todoMain} onClick={() => openEdit(todo)}>
        <div className={styles.todoTitle}>
          {todo.title}
          <span className={`${styles.priority} ${styles[`priority_${todo.priority}`]}`}>
            {PRIORITY_LABELS[todo.priority]}
          </span>
          {todo.due_date ? (
            <span
              className={`${styles.dueChip} ${todo.due_date < todayStr() && todo.status !== 'done' ? styles.dueOverdue : ''}`}
            >
              📅 {formatDate(todo.due_date)}
            </span>
          ) : null}
        </div>
        {todo.description ? <div className={styles.todoDesc}>{todo.description}</div> : null}
      </div>
      <div className={styles.todoActions}>
        <button className={styles.actionBtn} title="编辑" onClick={() => openEdit(todo)}>✎</button>
        <button className={`${styles.actionBtn} ${styles.actionDanger}`} title="删除" onClick={() => setDeleteTarget(todo)}>🗑</button>
      </div>
    </div>
  )

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← 返回</button>
        <h1 className={styles.title}>✅ 待办事项</h1>
        <div className={styles.headerStats}>
          <span className={styles.stat}>待办 {counts.pending}</span>
          <span className={styles.stat}>已完成 {counts.done}</span>
        </div>
      </header>

      <main className={styles.main}>
        {/* 快速添加 */}
        <div className={styles.addBar}>
          <input
            className={`input ${styles.addInput}`}
            value={title}
            placeholder="添加待办事项，Enter 确认…"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd()
            }}
          />
          <select
            className={`select ${styles.addPriority}`}
            value={priority}
            onChange={(e) => setPriority(e.target.value as TodoPriority)}
          >
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input
            type="date"
            className={`input ${styles.addDate}`}
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <button className="btn btn-primary" onClick={handleAdd} disabled={adding || !title.trim()}>
            添加
          </button>
        </div>

        {/* 过滤 */}
        <div className={styles.filterBar}>
          <Segmented options={[...FILTER_OPTIONS]} value={filter} onChange={setFilter} size="sm" />
          <input
            className={`input ${styles.searchInput}`}
            value={query}
            placeholder="搜索待办…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* 列表 */}
        {loading ? (
          <div className={styles.empty}><div className="spinner" />加载中…</div>
        ) : (
          <>
            {filter !== 'done' && buckets.map((bucket) => (
              <section key={bucket.key} className={styles.bucket}>
                <h3 className={`${styles.bucketLabel} ${bucket.key === 'overdue' ? styles.bucketOverdue : ''}`}>
                  {bucket.label}
                  <span className={styles.bucketCount}>{bucket.items.length}</span>
                </h3>
                <div className={styles.todoList}>{bucket.items.map(renderTodo)}</div>
              </section>
            ))}

            {(filter === 'done' || doneList.length > 0) && (
              <section className={styles.bucket}>
                <h3 className={styles.bucketLabel}>
                  已完成
                  <span className={styles.bucketCount}>{doneList.length}</span>
                </h3>
                <div className={styles.todoList}>
                  {doneList.length === 0 ? (
                    <div className={styles.emptySmall}>暂无已完成事项</div>
                  ) : (
                    doneList.map(renderTodo)
                  )}
                </div>
              </section>
            )}

            {todos.length === 0 && (
              <div className={styles.empty}>
                <div className={styles.emptyIcon}>🎉</div>
                <p>{query || filter !== 'all' ? '没有匹配的待办事项' : '暂无待办，享受轻松一刻～'}</p>
              </div>
            )}
          </>
        )}
      </main>

      {/* 编辑弹窗 */}
      <Modal
        open={!!editing}
        title="编辑待办"
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>标题</label>
          <input
            className="input"
            value={draft.title}
            autoFocus
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>描述</label>
          <textarea
            className={`input ${styles.formTextarea}`}
            rows={4}
            value={draft.description}
            placeholder="补充说明（可选）…"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>优先级</label>
            <select
              className="select"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value as TodoPriority })}
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>截止日期</label>
            <input
              type="date"
              className="input"
              value={draft.due_date}
              onChange={(e) => setDraft({ ...draft, due_date: e.target.value })}
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除待办"
        message={`确定删除「${deleteTarget?.title || ''}」吗？`}
        confirmText="删除"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
