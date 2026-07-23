import type { ForkfieldApi } from '../../shared/types'

declare global {
  interface Window {
    forkfield: ForkfieldApi
  }
}

export {}
