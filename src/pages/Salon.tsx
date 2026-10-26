import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { cachedQuery } from '../lib/offline'
import { createOrder, orderNumberLabel, updateOrder, useSyncedReload } from '../lib/orders'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatElapsed, formatMoney, minutesSince } from '../lib/format'
import type { Tables } from '../lib/database.types'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { initials, useTeam } from '../lib/team'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

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
  const [waiting, setWaiting] = useState<Set<string>>(new Set())
  const [readyOrders, setReadyOrders] = useState<Set<string>>(new Set())
  const [areaId, setAreaId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Table | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()
  const team = useTeam(rid)
  const { session } = useAuth()
  const me = session?.user.id
  // Los mozos pueden ver solo sus mesas
  const [mine, setMine] = useState(false)
  const nameOf = (id: string | null) => team.find((m) => m.user_id === id)?.name ?? null

  const loadOrders = useCallback(async () => {
    const [o, p] = await Promise.all([
      cachedQuery<Order>(
        `salon:${rid}:orders`,
        'orders',
        [
          { col: 'restaurant_id', op: 'eq', value: rid },
          { col: 'status', op: 'eq', value: 'open' },
          { col: 'table_id', op: 'notNull' },
        ],
        () => supabase.from('orders').select('*').eq('restaurant_id', rid).eq('status', 'open').not('table_id', 'is', null),
      ),
      cachedQuery<{ order_id: string; status: string }>(
        `salon:${rid}:flags`,
        'order_items',
        [
          { col: 'restaurant_id', op: 'eq', value: rid },
          { col: 'status', op: 'in', value: ['pending', 'ready'] },
        ],
        () => supabase.from('order_items').select('id, order_id, status, restaurant_id').eq('restaurant_id', rid).in('status', ['pending', 'ready']),
      ),
    ])
    if (o.error || p.error) setError(errorMessage(o.error ?? p.error))
    else {
      setOrders(o.data)
      setWaiting(new Set(p.data.filter((x) => x.status === 'pending').map((x) => x.order_id)))
      setReadyOrders(new Set(p.data.filter((x) => x.status === 'ready').map((x) => x.order_id)))
    }
  }, [rid])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [a, t] = await Promise.all([
        cachedQuery<Area>(`salon:${rid}:areas`, 'dining_areas', [], () =>
          supabase.from('dining_areas').select('*').eq('restaurant_id', rid).eq('active', true).order('sort_order'),
        ),
        cachedQuery<Table>(`salon:${rid}:tables`, 'tables', [], () =>
          supabase.from('tables').select('*').eq('restaurant_id', rid).eq('active', true).order('sort_order'),
        ),
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `restaurant_id=eq.${rid}` }, () => {
        void loadOrders()
      })
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [rid, loadOrders])

  useSyncedReload(loadOrders)

  const orderByTable = useMemo(() => {
    const map = new Map<string, Order>()
    for (const o of orders) if (o.table_id) map.set(o.table_id, o)
    return map
  }, [orders])

  const visible = tables.filter(
    (t) => t.area_id === areaId && (!mine || orderByTable.get(t.id)?.waiter_id === me),
  )
  const busyCount = visible.filter((t) => orderByTable.has(t.id)).length

  return (
    <>
      <TopBar title="Salón" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {role === 'waiter' && (
          <div className="switcher compact-wide" role="group" aria-label="Qué mesas ver">
            <button type="button" aria-pressed={!mine} onClick={() => setMine(false)}>Todas</button>
            <button type="button" aria-pressed={mine} onClick={() => setMine(true)}>Mis mesas</button>
          </div>
        )}

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
                const toSend = order ? waiting.has(order.id) : false
                const toServe = order ? readyOrders.has(order.id) : false
                return (
                  <button
                    key={t.id}
                    className={`table-tile${order ? ' busy' : ''}${toSend || toServe ? ' waiting' : ''}`}
                    onClick={() => setSelected(t)}
                    aria-label={`Mesa ${t.name}, ${order ? 'ocupada' : 'libre'}${toServe ? ', con platos listos' : toSend ? ', con pedido sin enviar' : ''}${order && nameOf(order.waiter_id) ? `, mozo ${nameOf(order.waiter_id)}` : ''}`}
                  >
                    <span className="num">{t.name}</span>
                    {order && nameOf(order.waiter_id) && (
                      <span className="tile-waiter" title={nameOf(order.waiter_id)!} aria-hidden="true">
                        {initials(nameOf(order.waiter_id)!)}
                      </span>
                    )}
                    <span className="meta">
                      {order ? (
                        <>
                          <strong>{order.total > 0 ? formatMoney(order.total) : 'Sin pedidos'}</strong>
                          <br />
                          {toServe ? 'Para servir' : toSend ? 'Sin enviar' : formatElapsed(minutesSince(order.opened_at, now))}

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
          waiterName={nameOf(orderByTable.get(selected.id)?.waiter_id ?? null)}
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
  waiterName,
  now,
  onClose,
  onChanged,
}: {
  table: Table
  order: Order | null
  canSell: boolean
  restaurantId: string
  waiterName: string | null
  now: number
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function openTable() {
    setBusy(true)
    setError(null)
    const { id, error } = await createOrder({
      restaurantId,
      type: 'dine_in',
      tableId: table.id,
      label: `Mesa ${table.name}: abrir`,
    })
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    navigate(`/comanda/${id}`)
  }

  async function releaseTable() {
    if (!order) return
    setBusy(true)
    setError(null)
    const { error } = await updateOrder(
      order.id,
      { status: 'cancelled', cancelled_reason: 'Mesa liberada sin consumo' },
      `Mesa ${table.name}: liberar`,
    )
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await onChanged()
    onClose()
  }

  const isEmpty = order !== null && order.total === 0 && order.paid_total === 0

  return (
    <Sheet
      title={<span className="big">Mesa {table.name}</span>}
      aside={<span className="badge">{order ? 'Ocupada' : 'Libre'}</span>}
      onClose={onClose}
    >
      {order ? (
        <div className="ticket">
          {waiterName && (
            <div className="ticket-row">
              <span>Mozo</span>
              <span>{waiterName}</span>
            </div>
          )}
          <div className="ticket-row">
            <span>{orderNumberLabel(order)}</span>
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

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      <div className="sheet-actions">
        {!order && canSell && (
          <button className="btn btn-primary" onClick={openTable} disabled={busy}>
            Abrir mesa y cargar pedido
          </button>
        )}
        {order && (
          <button className="btn btn-primary" onClick={() => navigate(`/comanda/${order.id}`)}>
            Ver comanda
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
    </Sheet>
  )
}
