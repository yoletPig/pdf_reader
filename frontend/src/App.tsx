import { Routes, Route } from 'react-router-dom'
import { Suspense, lazy } from 'react'

const HomePage = lazy(() => import('./pages/HomePage/HomePage'))
const SearchPage = lazy(() => import('./pages/SearchPage/SearchPage'))
const ReaderPage = lazy(() => import('./pages/ReaderPage/ReaderPage'))
const ChatPage = lazy(() => import('./pages/ChatPage/ChatPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage/SettingsPage'))
const VerifyPDFPage = lazy(() => import('./pages/VerifyPDFPage/VerifyPDFPage'))

function App() {
  return (
    <div className="app">
      <Suspense fallback={<div className="loading-screen">加载中...</div>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/reader/:id" element={<ReaderPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/verify-pdf" element={<VerifyPDFPage />} />
        </Routes>
      </Suspense>
    </div>
  )
}

export default App
