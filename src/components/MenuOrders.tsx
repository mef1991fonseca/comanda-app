import { createContext, useContext, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Sheet } from './Sheet'
import { formatMoney } from '../lib/format'
import { acceptMenuOrder, rejectMenuOrder, type MenuOrder } from '../lib/menuOrders'

const REASONS = ['Se terminó algo del pedido', 'La mesa no lo pidió', 'La cocina está cerrada']

function minutesAgo(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  return m === 0 ? 'recién' : `hace ${m} min`
}

/** Pedidos esperando, para que el Salón marque las mesas y abra la lista. */
export const MenuOrdersContext = createContext<{ orders: MenuOrder[]; openList: () => void }>({ orders: [], openList: () => undefined })
export const usePendingQr = () => useContext(MenuOrdersContext)

/** Aviso fijo cuando hay pedidos de la carta QR esperando. */
export function MenuOrdersBar({
  orders,
  open,
  setOpen,
  onChanged,
}: {
  orders: MenuOrder[]
  open: boolean
  setOpen: (v: boolean) => void
  onChanged: () => void
}) {
  const { pathname } = useLocation()
  // En la comanda y en cocina el aviso taparía los botones; queda el número en la navegación
  const hidden = pathname.startsWith('/comanda/') || pathname.startsWith('/cocina')
  if ((orders.length === 0 || hidden) && !open) return null
  const n = orders.length
  return (
    <>
      {n > 0 && !hidden && (
        <button className="menu-orders-bar" onClick={() => setOpen(true)}>
          <span className="pulse" aria-hidden="true" />
          <span>
            <strong>{n === 1 ? '1 pedido' : `${n} pedidos`}</strong> desde la carta QR
          </span>
          <span className="go">Ver</span>
        </button>
      )}
      {open && <MenuOrdersSheet orders={orders} onChanged={onChanged} onClose={() => setOpen(false)} />}
    </>
  )
}

function MenuOrdersSheet({ orders, onChanged, onClose }: { orders: MenuOrder[]; onChanged: () => void; onClose: () => void }) {
  const navigate = useNavigate()
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [done, setDone] = useState<{ table: string; orderId: string } | null>(null)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  async function accept(o: MenuOrder) {
    setBusy(o.id)
    setError(null)
    const res = await acceptMenuOrder(o.id)
    setBusy(null)
    if (res.error) {
      setError(res.error)
    } else if (res.orderId) {
      setDone({ table: o.table_name, orderId: res.orderId })
    }
    onChanged()
  }

  async function reject(o: MenuOrder) {
    setBusy(o.id)
    setError(null)
    const err = await rejectMenuOrder(o.id, reason.trim() || null)
    setBusy(null)
    if (err) setError(err)
    else {
      setRejecting(null)
      setReason('')
    }
    onChanged()
  }

  return (
    <Sheet title="Pedidos desde la carta" onClose={onClose}>
      <div className="form">
        {done && (
          <div className="notice notice-info" role="status">
            Mesa {done.table}: sumado a la comanda y enviado a cocina.{' '}
            <button className="link-btn" onClick={() => navigate(`/comanda/${done.orderId}`)}>Ver comanda</button>
          </div>
        )}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {orders.length === 0 && <p className="muted">No hay pedidos esperando.</p>}
        {orders.map((o) => (
          <article key={o.id} className="mo-card" aria-label={`Pedido de la mesa ${o.table_name}`}>
            <header className="mo-head">
              <span className="mo-table">Mesa {o.table_name}</span>
              <span className="muted">
                {o.customer_name ? `${o.customer_name} · ` : ''}
                {minutesAgo(o.created_at, now)}
              </span>
            </header>
            <ul className="mo-items">
              {o.items.map((l, i) => (
                <li key={i}>
                  <span className="qty">{l.quantity}</span>
                  <span className="what">
                    {l.name}
                    {l.modifiers.length > 0 && <span className="muted"> · {l.modifiers.map((m) => m.name).join(', ')}</span>}
                    {l.notes && <span className="mo-note">“{l.notes}”</span>}
                  </span>
                  <span className="amount">{formatMoney(l.unit_price * l.quantity)}</span>
                </li>
              ))}
            </ul>
            {o.note && <p className="mo-note">Nota: “{o.note}”</p>}
            <div className="mo-total">
              <span>Total</span>
              <span className="amount">{formatMoney(Number(o.total))}</span>
            </div>
            {rejecting === o.id ? (
              <div className="mo-reject">
                <div className="chips">
                  {REASONS.map((r) => (
                    <button key={r} type="button" className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>
                      {r}
                    </button>
                  ))}
                </div>
                <div className="field">
                  <label htmlFor={`mo-r-${o.id}`}>Motivo para el cliente</label>
                  <input id={`mo-r-${o.id}`} value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} placeholder="Opcional" />
                </div>
                <div className="sheet-actions">
                  <button className="btn btn-danger" disabled={busy === o.id} onClick={() => void reject(o)}>Rechazar pedido</button>
                  <button className="btn btn-quiet" onClick={() => setRejecting(null)}>Volver</button>
                </div>
              </div>
            ) : (
              <div className="sheet-actions">
                <button className="btn btn-primary" disabled={busy === o.id} onClick={() => void accept(o)}>
                  Aceptar y mandar a cocina
                </button>
                <button className="btn btn-quiet" disabled={busy === o.id} onClick={() => { setRejecting(o.id); setReason('') }}>
                  Rechazar
                </button>
              </div>
            )}
          </article>
        ))}
        <button className="btn btn-quiet" onClick={onClose}>Listo</button>
      </div>
    </Sheet>
  )
}
