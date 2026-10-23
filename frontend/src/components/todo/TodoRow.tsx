import type { TodoItem, TodoPriority } from '../../api/todos'
import styles from './TodoRow.module.css'

export const PRIORITY_LABELS: Record<TodoPriority, string> = { low: '低', medium: '中', high: '高' }

export function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatDateLabel(due: string) {
  if (!due) return ''
  const today = todayStr()
  if (due === today) return '今天'
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  if (due === tomorrowStr) return '明天'
  return due.slice(5).replace('-', '/')
}

interface TodoRowProps {
  todo: TodoItem
  onToggle: (todo: TodoItem) => void
  onEdit?: (todo: TodoItem) => void
  onDelete?: (todo: TodoItem) => void
  compact?: boolean
}

/** 单条待办行：勾选 + 标题/优先级/截止日期 + 操作 */
export function TodoRow({ todo, onToggle, onEdit, onDelete, compact }: TodoRowProps) {
  const overdue = !!todo.due_date && todo.due_date < todayStr() && todo.status !== 'done'
  return (
    <div className={`${styles.todoItem} ${todo.status === 'done' ? styles.todoDone : ''} ${compact ? styles.compact : ''}`}>
      <button
        className={styles.checkbox}
        title={todo.status === 'done' ? '标记为待办' : '标记为完成'}
        onClick={() => onToggle(todo)}
      >
        {todo.status === 'done' ? '✓' : ''}
      </button>
      <div className={styles.todoMain} onClick={() => onEdit?.(todo)}>
        <div className={styles.todoTitle}>
          {todo.title}
          <span className={`${styles.priority} ${styles[`priority_${todo.priority}`]}`}>
            {PRIORITY_LABELS[todo.priority]}
          </span>
          {todo.due_date ? (
            <span className={`${styles.dueChip} ${overdue ? styles.dueOverdue : ''}`}>
              📅 {formatDateLabel(todo.due_date)}
            </span>
          ) : null}
        </div>
        {!compact && todo.description ? <div className={styles.todoDesc}>{todo.description}</div> : null}
      </div>
      {(onEdit || onDelete) && (
        <div className={styles.todoActions}>
          {onEdit && <button className={styles.actionBtn} title="编辑" onClick={() => onEdit(todo)}>✎</button>}
          {onDelete && (
            <button className={`${styles.actionBtn} ${styles.actionDanger}`} title="删除" onClick={() => onDelete(todo)}>🗑</button>
          )}
        </div>
      )}
    </div>
  )
}
