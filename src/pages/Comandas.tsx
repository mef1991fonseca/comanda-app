import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatElapsed, formatMoney, minutesSince } from '../lib/format'
import { createOrder, orderTitle, useSyncedReload, type Order } from '../lib/orders'
import { cachedQuery } from '../lib/offline'
import type { Enums } from '../lib/database.types'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

type Row = { order: Order; tableName: string | null; pending: number; ready: number }

export function Comandas() {
  const { restaurant, role } = useCurrentRestaurant()
  const rid = restaurant.id
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [, setTick] = useState(0)

  const load = useCallback(async () => {
    const [o, t, i] = await Promise.all([
      cachedQuery<Order>(
        `comandas:${rid}:orders`,
        'orders',
        [
          { col: 'restaurant_id', op: 'eq', value: rid },
          { col: 'status', op: 'eq', value: 'open' },
        ],
        () => supabase.from('orders').select('*').eq('restaurant_id', rid).eq('status', 'open').order('opened_at'),
      ),
      cachedQuery<{ id: string; name: string }>(`comandas:${rid}:tables`, 'tables', [], () =>
        supabase.from('tables').select('id, name').eq('restaurant_id', rid),
      ),
      cachedQuery<{ order_id: string; status: string }>(
        `comandas:${rid}:flags`,
        'order_items',
        [
          { col: 'restaurant_id', op: 'eq', value: rid },
          { col: 'status', op: 'in', value: ['pending', 'ready'] },
        ],
        () => supabase.from('order_items').select('id, order_id, status, restaurant_id').eq('restaurant_id', rid).in('status', ['pending', 'ready']),
      ),
    ])
    if (o.error || t.error || i.error) {
      setError(errorMessage(o.error ?? t.error ?? i.error))
    } else {
      const names = new Map(t.data.map((x) => [x.id, x.name]))
      const count = (status: string) => {
        const m = new Map<string, number>()
        for (const x of i.data) if (x.status === status) m.set(x.order_id, (m.get(x.order_id) ?? 0) + 1)
        return m
      }
      const pending = count('pending')
      const ready = count('ready')
      setRows(
        o.data.map((order) => ({
          order,
          tableName: order.table_id ? names.get(order.table_id) ?? null : null,
          pending: pending.get(order.id) ?? 0,
          ready: ready.get(order.id) ?? 0,
        })),
      )
      setError(null)
    }
    setLoading(false)
  }, [rid])

  useSyncedReload(load)

  useEffect(() => {
    void load()
    const channel = supabase
      .channel(`comandas-${rid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${rid}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `restaurant_id=eq.${rid}` }, () => void load())
      .subscribe()
    const timer = setInterval(() => setTick((x) => x + 1), 30_000)
    return () => {
      void supabase.removeChannel(channel)
      clearInterval(timer)
    }
  }, [rid, load])

  const canSell = ['owner', 'manager', 'cashier', 'waiter'].includes(role)

  return (
    <>
      <TopBar title="Comandas" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {canSell && (
          <div className="toolbar">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>Venta de mostrador</button>
          </div>
        )}

        {loading ? (
          <p className="muted">Cargando comandas…</p>
        ) : rows.length === 0 ? (
          <div className="empty">
            <h2>No hay comandas abiertas</h2>
            <p className="muted">Abrí una mesa desde el Salón o empezá una venta de mostrador.</p>
          </div>
        ) : (
          <div className="list">
            {rows.map(({ order, tableName, pending, ready }) => (
              <button key={order.id} className="list-row" onClick={() => navigate(`/comanda/${order.id}`)}>
                <span className="product-line">
                  <span>{orderTitle(order, tableName)}</span>
                  <span className="product-sub">
                    {order.number ? `#${order.number}` : 'Sin número aún'} · hace {formatElapsed(minutesSince(order.opened_at))}
                    {pending > 0 && <span className="pending-flag"> · {pending} por enviar</span>}
                    {ready > 0 && <span className="pending-flag"> · {ready} listo{ready > 1 ? 's' : ''} para servir</span>}
                  </span>
                </span>
                <span className="price">{formatMoney(order.total)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CounterSaleSheet
          restaurantId={rid}
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/comanda/${id}`)}
        />
      )}
    </>
  )
}

function CounterSaleSheet({
  restaurantId,
  onClose,
  onCreated,
}: {
  restaurantId: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [type, setType] = useState<Enums<'order_type'>>('counter')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    const customer = name.trim() || null
    const { id, error } = await createOrder({
      restaurantId,
      type,
      customerName: customer,
      label: `${type === 'takeaway' ? 'Para llevar' : 'Mostrador'}${customer ? ` · ${customer}` : ''}: abrir`,
    })
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    onCreated(id)
  }

  return (
    <Sheet title="Venta de mostrador" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="switcher" role="group" aria-label="Tipo de venta">
          <button type="button" aria-pressed={type === 'counter'} onClick={() => setType('counter')}>Para comer acá</button>
          <button type="button" aria-pressed={type === 'takeaway'} onClick={() => setType('takeaway')}>Para llevar</button>
        </div>
        <div className="field">
          <label htmlFor="cust">Nombre del cliente</label>
          <input id="cust" value={name} onChange={(e) => setName(e.target.value)} placeholder="Opcional, para llamarlo" />
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy}>Empezar venta</button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  )
}
