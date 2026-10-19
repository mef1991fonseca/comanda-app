import { useEffect, useState } from 'react'
import { onSyncState, syncState, type SyncState } from './offline'

/** Estado de conexión y de la cola de cambios pendientes, para la interfaz. */
export function useSync(): SyncState {
  const [state, setState] = useState<SyncState>(syncState)
  useEffect(() => onSyncState(setState), [])
  return state
}
