import axios from 'axios'

const apiClient = axios.create({
  baseURL: '/api',
  // 与后端 LLM_TIMEOUT(300s) 对齐，避免长文本翻译在后端完成前被客户端中断
  timeout: 300000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => config,
  (error) => Promise.reject(error),
)

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('API Error:', error.response?.data || error.message)
    return Promise.reject(error)
  },
)

export default apiClient
