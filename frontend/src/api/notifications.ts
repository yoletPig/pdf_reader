/**
 * 消息通知 API - 全局收件箱
 */
import apiClient from './client'

export type NotificationType = 'todo' | 'papers' | 'system' | string

export interface NotificationItem {
  id: string
  type: NotificationType
  title: string
  body: string
  link: string
  read: boolean
  created_at: string
  read_at: string
}

export interface NotificationListResponse {
  notifications: NotificationItem[]
  unread_count: number
}

export const notificationsApi = {
  list: (params?: { limit?: number }) =>
    apiClient.get<NotificationListResponse>('/notifications', { params }),
  markRead: (id: string) => apiClient.post(`/notifications/${id}/read`),
  markAllRead: () => apiClient.post<{ status: string; marked: number }>('/notifications/read-all'),
  delete: (id: string) => apiClient.delete(`/notifications/${id}`),
  clearRead: () => apiClient.delete<{ status: string; cleared: number }>('/notifications'),
}
