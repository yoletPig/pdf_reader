/**
 * 待办事项 API
 */
import apiClient from './client'

export type TodoStatus = 'pending' | 'done'
export type TodoPriority = 'low' | 'medium' | 'high'

export interface TodoItem {
  id: string
  title: string
  description: string
  status: TodoStatus
  priority: TodoPriority
  due_date: string
  source_type: string
  created_at: string
  updated_at: string
  completed_at: string
}

export interface TodoListResponse {
  todos: TodoItem[]
  total_count: number
  pending_count: number
  done_count: number
}

export interface TodoCreateData {
  title: string
  description?: string
  priority?: TodoPriority
  due_date?: string
  source_type?: string
  source_ref?: Record<string, unknown>
}

export interface TodoUpdateData {
  title?: string
  description?: string
  status?: TodoStatus
  priority?: TodoPriority
  due_date?: string
}

export const todosApi = {
  list: (params?: { status?: string; q?: string }) =>
    apiClient.get<TodoListResponse>('/todos', { params }),
  create: (data: TodoCreateData) => apiClient.post<TodoItem>('/todos', data),
  update: (id: string, data: TodoUpdateData) => apiClient.patch<TodoItem>(`/todos/${id}`, data),
  delete: (id: string) => apiClient.delete(`/todos/${id}`),
}
