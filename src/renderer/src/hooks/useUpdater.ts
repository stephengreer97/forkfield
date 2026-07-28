import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/types'

export function useUpdater() {
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })

  useEffect(() => {
    // Get initial status
    window.forkfield.getUpdateStatus().then(setUpdateState).catch(console.error)

    // Listen for updates
    const unsubscribe = window.forkfield.onUpdaterStatus(setUpdateState)
    return unsubscribe
  }, [])

  const checkForUpdates = async () => {
    try {
      await window.forkfield.checkForUpdates()
    } catch (err) {
      console.error('Failed to check for updates:', err)
    }
  }

  const installUpdate = () => {
    window.forkfield.quitAndInstall()
  }

  const openDownloadPage = () => {
    window.forkfield.openDownloadPage()
  }

  return { updateState, checkForUpdates, installUpdate, openDownloadPage }
}
