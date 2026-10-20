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

/** 设置项定义（后端返回） */
export interface SettingField {
  key: string
  label: string
  type: 'string' | 'secret' | 'number' | 'enum' | 'boolean'
  value: string | number | boolean | null
  default?: string | number | boolean | null
  overridden: boolean
  has_value?: boolean
  choices?: Array<{ value: string; label: string }>
  description?: string
}

export interface SettingGroup {
  title: string
  description: string
  fields: SettingField[]
}

export interface SystemSettingsResponse {
  groups: Record<string, SettingGroup>
}

export const configApi = {
  getModel: () => apiClient.get<AppModelConfig>('/config/model'),
  testModel: () => apiClient.post('/config/test'),
  /** 读取全部系统设置（secret 已脱敏） */
  getSettings: () => apiClient.get<SystemSettingsResponse>('/config/settings'),
  /** 保存单个设置项；value 为空字符串/null 表示重置回默认 */
  saveSetting: (key: string, value: string | number | boolean | null) =>
    apiClient.put('/config/settings', { key, value }),
  /** 批量保存设置项（设置页统一保存按钮）；value 为空字符串/null 表示重置回默认 */
  saveSettings: (items: Array<{ key: string; value: string | number | boolean | null }>) =>
    apiClient.put<{ status: string; saved: string[]; reset: string[]; pdf_engine?: string }>(
      '/config/settings/batch',
      { settings: items },
    ),
  /** PDF 引擎列表与当前值 */
  getEngines: () => apiClient.get<{ engines: Array<{ value: string; label: string; description: string }>; current: string }>('/config/engines'),
}
