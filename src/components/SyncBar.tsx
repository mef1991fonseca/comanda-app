import { useState } from 'react'
import { discardFailed } from '../lib/offline'
import { useSync } from '../lib/useSync'
import { Sheet } from './Sheet'

/**
 * Estado de conexión y sincronización, siempre arriba:
 *  - sin conexión (mostaza): se puede seguir trabajando, los cambios quedan en el dispositivo
 *  - sincronizando: se están enviando los cambios guardados
 *  - rechazados (tomate): la base no aceptó algún cambio; se muestra cuál y por qué
 */
export function SyncBar() {
  const { online, pending, failed, syncing } = useSync()
  const [open, setOpen] = useState(false)

  return (
    <>
      {!online ? (
        <div className="sync-bar offline" role="status">
          Sin conexión. Podés seguir tomando pedidos y cobrando
          {pending > 0 ? `: ${pending} ${pending === 1 ? 'cambio guardado' : 'cambios guardados'} en este dispositivo.` : '.'}
        </div>
      ) : pending > 0 ? (
        <div className="sync-bar syncing" role="status">
          {syncing ? 'Sincronizando' : 'Por sincronizar'} {pending} {pending === 1 ? 'cambio' : 'cambios'}…
        </div>
      ) : null}

      {failed.length > 0 && (
        <button className="sync-bar failed" onClick={() => setOpen(true)}>
          {failed.some((f) => f.table === 'payments')
            ? 'Hay cobros hechos sin conexión que no se registraron. Ver detalle'
            : `${failed.length === 1 ? '1 cambio no se pudo guardar' : `${failed.length} cambios no se pudieron guardar`}. Ver detalle`}
        </button>
      )}

      {open && (
        <Sheet title="Cambios no guardados" onClose={() => setOpen(false)}>
          <p className="muted">
            Se hicieron sin conexión y, al sincronizar, el sistema no los aceptó. Revisá la comanda y volvé a cargarlos si hace falta.
          </p>
          {failed.some((f) => f.table === 'payments') && (
            <div className="notice notice-error">
              Un cobro no registrado es plata que ya entró pero no figura en la caja. Cargalo de nuevo en la comanda o como
              ingreso de caja antes de descartarlo.
            </div>
          )}
          <div className="list">
            {failed.map((f) => (
              <div key={f.id} className="list-row">
                <span className="product-line">
                  <span>{f.label}</span>
                  <span className="product-sub">{f.error}</span>
                </span>
                <button className="link-btn" onClick={() => void discardFailed(f.id)}>Descartar</button>
              </div>
            ))}
          </div>
          <div className="sheet-actions">
            <button
              className="btn btn-quiet"
              onClick={() => {
                void discardFailed()
                setOpen(false)
              }}
            >
              Descartar todos
            </button>
          </div>
        </Sheet>
      )}
    </>
  )
}
