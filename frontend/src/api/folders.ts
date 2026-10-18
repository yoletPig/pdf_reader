/**
 * 文件夹与标签 API - 论文组织管理
 */
import apiClient from './client'

export interface FolderItem {
  id: string
  name: string
  parent_id: string
  icon: string
  color: string
  sort_order: number
  paper_count: number
  created_at: string
}

export interface FoldersResponse {
  folders: FolderItem[]
  uncategorized_count: number
  total_count: number
}

export interface TagCount {
  name: string
  count: number
}

export const foldersApi = {
  list: () => apiClient.get<FoldersResponse>('/folders'),
  create: (data: { name: string; parent_id?: string; icon?: string; color?: string }) =>
    apiClient.post<FolderItem>('/folders', data),
  update: (id: string, data: { name: string; parent_id?: string; icon?: string; color?: string; sort_order?: number }) =>
    apiClient.patch<FolderItem>(`/folders/${id}`, data),
  delete: (id: string) => apiClient.delete(`/folders/${id}`),
  assignPaper: (paperId: string, folderId: string) =>
    apiClient.put(`/folders/assign/${paperId}`, { folder_id: folderId }),
  setTags: (paperId: string, tags: string[]) =>
    apiClient.put(`/folders/tags/${paperId}`, { tags }),
  allTags: () => apiClient.get<{ tags: TagCount[] }>('/folders/tags/all'),
}
