import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './styles.css'

// Errors raised outside React's render path — event handlers, timers, IPC
// callbacks — never reach the boundary, so they are reported separately.
window.addEventListener('error', (e) => {
  window.forkfield?.reportError({
    kind: 'uncaught',
    message: e.message,
    stack: e.error instanceof Error ? (e.error.stack ?? null) : null,
    componentStack: null
  })
})

window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason
  window.forkfield?.reportError({
    kind: 'unhandled-rejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? (reason.stack ?? null) : null,
    componentStack: null
  })
})

const container = document.getElementById('root')
if (!container) throw new Error('root element missing')

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
