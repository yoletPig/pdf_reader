import apiClient from './client'

export interface PromptTemplate {
  id: string
  agent_mode: string
  layer: string
  name: string
  content: string
  version: number
  is_active: boolean
}

export interface PromptListResponse {
  templates: PromptTemplate[]
}

export const promptsApi = {
  list: () => apiClient.get<PromptListResponse>('/prompts'),
  update: (id: string, data: Partial<PromptTemplate>) => apiClient.put(`/prompts/${id}`, data),
  revert: (id: string) => apiClient.post(`/prompts/${id}/revert`),
}
