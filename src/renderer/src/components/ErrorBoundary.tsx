import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// Without this, a throw anywhere in the tree unmounts everything and leaves a
// blank window with nothing in the log to explain it.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    window.forkfield?.reportError({
      kind: 'render',
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null
    })
  }

  render(): ReactNode {
    const err = this.state.error
    if (!err) return this.props.children

    return (
      <div className="crash">
        <div className="crash-box">
          <h1 className="crash-title">Forkfield hit an error</h1>
          <p className="crash-msg">{err.message || 'Unknown error'}</p>
          <p className="crash-hint">
            The details were written to <code>forkfield-errors.log</code> in the app data folder.
            Reloading restores the last saved canvas.
          </p>
          {err.stack && <pre className="crash-stack">{err.stack}</pre>}
          <div className="crash-actions">
            <button className="crash-btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button
              className="crash-btn crash-btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
