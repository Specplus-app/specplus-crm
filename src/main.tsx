import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

// Remove any previously installed service worker and purge its caches so
// returning visitors are never stuck on a stale, cached version of the app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) => registrations.forEach((registration) => registration.unregister()))
    .catch(() => {})
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key))).catch(() => {})
  }
}
