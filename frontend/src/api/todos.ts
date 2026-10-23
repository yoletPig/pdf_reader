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
  list_id: string
  source_type: string
  created_at: string
  updated_at: string
  completed_at: string
}

export interface TodoListInfo {
  id: string
  name: string
  icon: string
  color: string
  sort_order: number
  pending_count: number
  done_count: number
  created_at: string
}

export interface TodoListsResponse {
  lists: TodoListInfo[]
  inbox: { pending_count: number; done_count: number }
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
  list_id?: string
  source_type?: string
  source_ref?: Record<string, unknown>
}

export interface TodoUpdateData {
  title?: string
  description?: string
  status?: TodoStatus
  priority?: TodoPriority
  due_date?: string
  list_id?: string
}

export interface TodoListData {
  name: string
  icon?: string
  color?: string
}

export const todosApi = {
  list: (params?: { status?: string; q?: string; list_id?: string }) =>
    apiClient.get<TodoListResponse>('/todos', { params }),
  create: (data: TodoCreateData) => apiClient.post<TodoItem>('/todos', data),
  update: (id: string, data: TodoUpdateData) => apiClient.patch<TodoItem>(`/todos/${id}`, data),
  delete: (id: string) => apiClient.delete(`/todos/${id}`),
  listLists: () => apiClient.get<TodoListsResponse>('/todos/lists'),
  createList: (data: TodoListData) => apiClient.post<TodoListInfo>('/todos/lists', data),
  updateList: (id: string, data: TodoListData) => apiClient.patch<TodoListInfo>(`/todos/lists/${id}`, data),
  deleteList: (id: string) => apiClient.delete(`/todos/lists/${id}`),
}
