import type { JSX } from 'react'
import { useUpdater } from '../hooks/useUpdater'
import Icon from './Icon'

export default function UpdateBanner(): JSX.Element | null {
  const { updateState, installUpdate } = useUpdater()

  if (updateState.status === 'ready') {
    return (
      <div className="update-banner">
        <div className="update-content">
          <span className="update-icon">
            <Icon name="alert" size={16} />
          </span>
          <span className="update-text">
            Update {updateState.version} is ready to install.
          </span>
          <button className="update-action btn tiny primary" onClick={installUpdate}>
            Install & Restart
          </button>
        </div>
      </div>
    )
  }

  if (updateState.status === 'available') {
    return (
      <div className="update-banner available">
        <div className="update-content">
          <span className="update-icon">
            <Icon name="plus" size={16} />
          </span>
          <span className="update-text">
            Forkfield {updateState.version} is available. Downloading…
          </span>
        </div>
      </div>
    )
  }

  if (updateState.status === 'error') {
    return (
      <div className="update-banner error">
        <div className="update-content">
          <span className="update-icon">
            <Icon name="alert" size={16} />
          </span>
          <span className="update-text">
            Update check failed: {updateState.error || 'unknown error'}
          </span>
        </div>
      </div>
    )
  }

  return null
}
