import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatElapsed, formatMoney, minutesSince } from '../lib/format'
import type { Tables } from '../lib/database.types'
import { TopBar } from '../components/AppShell'

type Area = Tables<'dining_areas'>
type Table = Tables<'tables'>
type Order = Tables<'orders'>

const SELLER_ROLES = ['owner', 'manager', 'cashier', 'waiter']

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function Salon() {
  const { restaurant, role } = useCurrentRestaurant()
  const rid = restaurant.id
  const [areas, setAreas] = useState<Area[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [areaId, setAreaId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Table | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  const loadOrders = useCallback(async () => {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('restaurant_id', rid)
      .eq('status', 'open')
      .not('table_id', 'is', null)
    if (error) setError(errorMessage(error))
    else setOrders(data)
  }, [rid])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [a, t] = await Promise.all([
        supabase.from('dining_areas').select('*').eq('restaurant_id', rid).eq('active', true).order('sort_order'),
        supabase.from('tables').select('*').eq('restaurant_id', rid).eq('active', true).order('sort_order'),
      ])
      if (cancelled) return
      if (a.error || t.error) setError(errorMessage(a.error ?? t.error))
      else {
        setAreas(a.data)
        setTables(t.data)
        setAreaId((cur) => cur ?? a.data[0]?.id ?? null)
      }
      await loadOrders()
      if (!cancelled) setLoading(false)
    }
    void load()

    // Cualquier cambio en comandas del local (otro mozo abre una mesa) refresca el salón
    const channel = supabase
      .channel(`salon-${rid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${rid}` }, () => {
        void loadOrders()
      })
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [rid, loadOrders])

  const orderByTable = useMemo(() => {
    const map = new Map<string, Order>()
    for (const o of orders) if (o.table_id) map.set(o.table_id, o)
    return map
  }, [orders])

  const visible = tables.filter((t) => t.area_id === areaId)
  const busyCount = visible.filter((t) => orderByTable.has(t.id)).length

  return (
    <>
      <TopBar title="Salón" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {areas.length > 1 && (
          <div className="areas" role="group" aria-label="Salones">
            {areas.map((a) => (
              <button key={a.id} aria-pressed={a.id === areaId} onClick={() => setAreaId(a.id)}>
                {a.name}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <p className="muted">Cargando el salón…</p>
        ) : visible.length === 0 ? (
          <div className="empty">
            <h2>Este salón no tiene mesas</h2>
            <p className="muted">Agregá mesas desde la configuración del local para empezar a tomar pedidos.</p>
          </div>
        ) : (
          <>
            <div className="floor-summary" aria-live="polite">
              <span><strong>{busyCount}</strong>{busyCount === 1 ? 'ocupada' : 'ocupadas'}</span>
              <span><strong>{visible.length - busyCount}</strong>{visible.length - busyCount === 1 ? 'libre' : 'libres'}</span>
            </div>
            <div className="floor">
              {visible.map((t) => {
                const order = orderByTable.get(t.id)
                return (
                  <button
                    key={t.id}
                    className={`table-tile${order ? ' busy' : ''}`}
                    onClick={() => setSelected(t)}
                    aria-label={`Mesa ${t.name}, ${order ? 'ocupada' : 'libre'}`}
                  >
                    <span className="num">{t.name}</span>
                    <span className="meta">
                      {order ? (
                        <>
                          <strong>{order.total > 0 ? formatMoney(order.total) : 'Sin pedidos'}</strong>
                          <br />
                          {formatElapsed(minutesSince(order.opened_at, now))}
                        </>
                      ) : (
                        `${t.seats} lugares`
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {selected && (
        <TableSheet
          table={selected}
          order={orderByTable.get(selected.id) ?? null}
          canSell={SELLER_ROLES.includes(role)}
          restaurantId={rid}
          now={now}
          onClose={() => setSelected(null)}
          onChanged={loadOrders}
        />
      )}
    </>
  )
}

function TableSheet({
  table,
  order,
  canSell,
  restaurantId,
  now,
  onClose,
  onChanged,
}: {
  table: Table
  order: Order | null
  canSell: boolean
  restaurantId: string
  now: number
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function run(action: () => PromiseLike<{ error: unknown }>) {
    setBusy(true)
    setError(null)
    const { error } = await action()
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await onChanged()
    setBusy(false)
    onClose()
  }

  const openTable = () =>
    run(() => supabase.from('orders').insert({ restaurant_id: restaurantId, type: 'dine_in', table_id: table.id }))

  const releaseTable = () =>
    order &&
    run(() =>
      supabase.from('orders').update({ status: 'cancelled', cancelled_reason: 'Mesa liberada sin consumo' }).eq('id', order.id),
    )

  const isEmpty = order !== null && order.total === 0 && order.paid_total === 0

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span id="sheet-title" className="big">Mesa {table.name}</span>
          <span className="badge">{order ? 'Ocupada' : 'Libre'}</span>
        </div>

        {order ? (
          <div className="ticket">
            <div className="ticket-row">
              <span>Comanda #{order.number}</span>
              <span className="muted">abierta hace {formatElapsed(minutesSince(order.opened_at, now))}</span>
            </div>
            <div className="ticket-row">
              <span>Total</span>
              <span className="amount">{formatMoney(order.total)}</span>
            </div>
            <div className="ticket-row">
              <span>Pagado</span>
              <span className="amount">{formatMoney(order.paid_total)}</span>
            </div>
          </div>
        ) : (
          <p className="muted">{table.seats} lugares. Abrila para empezar a cargar el pedido.</p>
        )}

        {order && (
          <p className="muted">Cargar productos estará disponible cuando armes la carta del local.</p>
        )}

        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="sheet-actions">
          {!order && canSell && (
            <button className="btn btn-primary" onClick={openTable} disabled={busy}>
              Abrir mesa
            </button>
          )}
          {order && canSell && isEmpty && (
            <button className="btn btn-danger" onClick={releaseTable} disabled={busy}>
              Liberar mesa
            </button>
          )}
          <button className="btn btn-quiet" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
