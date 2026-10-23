import { useCallback, useState } from 'react'

const STORAGE_KEY = 'pdf-reader.sidebar-collapsed'

/** 侧边栏折叠状态（localStorage 持久化，多页面共享） */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        /* 忽略存储异常 */
      }
      return next
    })
  }, [])

  return { collapsed, toggle }
}
