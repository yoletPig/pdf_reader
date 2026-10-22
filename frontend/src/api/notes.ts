/**
 * 笔记 API - Markdown 笔记 + 图片上传
 */
import apiClient from './client'

export interface NoteSourceRef {
  session_id?: string
  message_id?: string
  session_title?: string
  [key: string]: unknown
}

export interface NoteSummary {
  id: string
  title: string
  snippet: string
  tags: string[]
  paper_id: string
  template_id: string
  source_type: 'manual' | 'chat' | string
  source_ref: NoteSourceRef
  pinned: boolean
  created_at: string
  updated_at: string
}

export interface NoteDetail extends NoteSummary {
  content_md: string
}

export interface NoteCreateData {
  title?: string
  content_md?: string
  tags?: string[]
  paper_id?: string
  template_id?: string
  source_type?: string
  source_ref?: NoteSourceRef
  pinned?: boolean
}

export interface NoteUpdateData {
  title?: string
  content_md?: string
  tags?: string[]
  paper_id?: string
  pinned?: boolean
}

export interface NoteListResponse {
  notes: NoteSummary[]
  total_count: number
  tags: { name: string; count: number }[]
}

export interface NoteImageUpload {
  filename: string
  url: string
}

export const notesApi = {
  list: (params?: { q?: string; tag?: string; paper_id?: string; source_type?: string }) =>
    apiClient.get<NoteListResponse>('/notes', { params }),
  get: (id: string) => apiClient.get<NoteDetail>(`/notes/${id}`),
  create: (data: NoteCreateData) => apiClient.post<NoteDetail>('/notes', data),
  update: (id: string, data: NoteUpdateData) => apiClient.patch<NoteDetail>(`/notes/${id}`, data),
  delete: (id: string) => apiClient.delete(`/notes/${id}`),
  uploadImage: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return apiClient.post<NoteImageUpload>('/notes/images', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
}
