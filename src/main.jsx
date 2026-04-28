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

// PWA install prompt capture — Chrome/Edge/Brave fire `beforeinstallprompt`
// when the app is installable. We stash the event so any component (e.g.
// the Share/Install section in Profile) can call `prompt()` later when
// the user opts in. iOS Safari never fires this — install is manual via
// Add to Home Screen.
window.__aueDeferredInstallPrompt = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  window.__aueDeferredInstallPrompt = e
  window.dispatchEvent(new CustomEvent('aue-install-available'))
})
window.addEventListener('appinstalled', () => {
  window.__aueDeferredInstallPrompt = null
  window.dispatchEvent(new CustomEvent('aue-install-installed'))
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
