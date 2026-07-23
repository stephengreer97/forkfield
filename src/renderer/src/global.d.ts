import type { BranchpadApi } from '../../shared/types'

declare global {
  interface Window {
    branchpad: BranchpadApi
  }
}

export {}
