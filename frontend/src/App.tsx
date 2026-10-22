import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Suspense, lazy } from 'react'
import { ToastProvider } from './components/ui/kit'
import './styles/theme.css'
import './styles/globals.css'

const HomePage = lazy(() => import('./pages/HomePage/HomePage'))
const SearchPage = lazy(() => import('./pages/SearchPage/SearchPage'))
const ReaderPage = lazy(() => import('./pages/ReaderPage/ReaderPage'))
const ChatPage = lazy(() => import('./pages/ChatPage/ChatPage'))
const NotesPage = lazy(() => import('./pages/NotesPage/NotesPage'))
const TodoPage = lazy(() => import('./pages/TodoPage/TodoPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage/SettingsPage'))
const VerifyPDFPage = lazy(() => import('./pages/VerifyPDFPage/VerifyPDFPage'))

function useThemeInit() {
  useEffect(() => {
    const stored = window.localStorage.getItem('pdf-reader-theme') as 'light' | 'dark' | null
    const theme = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    document.documentElement.setAttribute('data-theme', theme)
  }, [])
}

function App() {
  useThemeInit()
  return (
    <ToastProvider>
      <div className="app">
        <Suspense
          fallback={
            <div className="loading-screen">
              <div className="spinner" />
              <span>加载中…</span>
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/reader/:id" element={<ReaderPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/todos" element={<TodoPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/verify-pdf" element={<VerifyPDFPage />} />
          </Routes>
        </Suspense>
      </div>
    </ToastProvider>
  )
}

export default App
