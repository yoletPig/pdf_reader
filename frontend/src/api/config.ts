import apiClient from './client'

export interface AppModelConfig {
  configured: boolean
  api_key: string
  base_url: string
  model: string
  max_tokens: number
  temperature: number
  trust_env: boolean
}

export const configApi = {
  getModel: () => apiClient.get<AppModelConfig>('/config/model'),
  testModel: () => apiClient.post('/config/test'),
}
