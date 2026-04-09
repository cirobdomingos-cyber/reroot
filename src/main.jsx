import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import { reportError } from './services/api'
import App from './App'
import './styles/globals.css'

// Global error handlers — catch uncaught JS errors in production
window.addEventListener('error', (event) => {
  reportError('js_uncaught', event.message, {
    filename: event.filename,
    line: event.lineno,
    col: event.colno,
  })
})
window.addEventListener('unhandledrejection', (event) => {
  reportError('js_unhandled_promise', String(event.reason).slice(0, 500))
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </StrictMode>
)
