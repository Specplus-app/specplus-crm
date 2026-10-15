import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { LEAD_PATH_RE } from './lib/pushSupport'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

// Remove any previously installed caching service worker and purge its caches
// so returning visitors are never stuck on a stale, cached version of the app.
// The only worker kept is the push-only /push-sw.js (staff notifications),
// which has no fetch handler and caches nothing.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) => registrations.forEach((registration) => {
      const worker = registration.active ?? registration.waiting ?? registration.installing
      if (!worker?.scriptURL.endsWith('/push-sw.js')) registration.unregister()
    }))
    .catch(() => {})
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key))).catch(() => {})
  }
  // A tapped notification asks an already-open window to show the lead.
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; url?: unknown } | null
    if (data?.type === 'open-url' && typeof data.url === 'string' && LEAD_PATH_RE.test(data.url)) window.location.assign(data.url)
  })
}
