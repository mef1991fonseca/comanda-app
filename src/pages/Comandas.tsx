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
import { InvoiceForm } from '../components/InvoiceForm'
import { cbteLabel, invoiceNumber, type Invoice } from '../lib/invoices'
import type { Customer } from '../lib/customers'
import { useSync } from '../lib/useSync'

type Row = { order: Order; tableName: string | null; pending: number; ready: number }

export function Comandas() {
  const { restaurant, role } = useCurrentRestaurant()
  const rid = restaurant.id
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [view, setView] = useState<'open' | 'closed'>('open')
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
  const canSeeClosed = ['owner', 'manager', 'cashier'].includes(role)

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

        {canSeeClosed && (
          <div className="switcher orders-view" role="group" aria-label="Qué comandas ver">
            <button type="button" aria-pressed={view === 'open'} onClick={() => setView('open')}>Abiertas</button>
            <button type="button" aria-pressed={view === 'closed'} onClick={() => setView('closed')}>Cerradas</button>
          </div>
        )}

        {view === 'closed' ? (
          <ClosedOrders restaurantId={rid} />
        ) : loading ? (
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

const closedFmt = new Intl.DateTimeFormat('es-AR', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })

type ClosedRow = { order: Order; tableName: string | null; invoice: Invoice | null }

/** Comandas cerradas de los últimos 7 días, con su factura (si tiene) y el botón para facturar las que no. */
function ClosedOrders({ restaurantId }: { restaurantId: string }) {
  const navigate = useNavigate()
  const { online } = useSync()
  const [rows, setRows] = useState<ClosedRow[] | null>(null)
  const [fiscalOn, setFiscalOn] = useState(false)
  const [onlyPending, setOnlyPending] = useState(false)
  const [invoicing, setInvoicing] = useState<{ order: Order; customer: Customer | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const [o, t, f] = await Promise.all([
      supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .eq('status', 'closed')
        .gte('closed_at', since)
        .order('closed_at', { ascending: false })
        .limit(100),
      supabase.from('tables').select('id, name').eq('restaurant_id', restaurantId),
      supabase.from('fiscal_settings').select('enabled').eq('restaurant_id', restaurantId).maybeSingle(),
    ])
    if (o.error) return setError(errorMessage(o.error))
    const orders = o.data ?? []
    const ids = orders.map((x) => x.id)
    const inv = ids.length
      ? await supabase
          .from('invoices')
          .select('*')
          .in('order_id', ids)
          .eq('status', 'authorized')
          .in('cbte_type', [1, 6, 11])
          .is('credit_note_id', null)
      : { data: [] as Invoice[], error: null }
    const byOrder = new Map((inv.data ?? []).map((x) => [x.order_id, x]))
    const names = new Map((t.data ?? []).map((x) => [x.id, x.name]))
    setFiscalOn(Boolean(f.data?.enabled))
    setRows(
      orders.map((order) => ({
        order,
        tableName: order.table_id ? names.get(order.table_id) ?? null : null,
        invoice: byOrder.get(order.id) ?? null,
      })),
    )
    setError(null)
  }, [restaurantId])

  useEffect(() => {
    void load()
  }, [load])

  async function startInvoice(order: Order) {
    let customer: Customer | null = null
    if (order.customer_id) {
      const { data } = await supabase.from('customers').select('*').eq('id', order.customer_id).maybeSingle()
      customer = data
    }
    setInvoicing({ order, customer })
  }

  if (!online) return <p className="muted">Las comandas cerradas se ven con conexión.</p>
  if (error) return <div className="notice notice-error" role="alert">{error}</div>
  if (!rows) return <p className="muted">Cargando comandas cerradas…</p>

  const pendingCount = rows.filter((r) => !r.invoice).length
  const shown = onlyPending ? rows.filter((r) => !r.invoice) : rows

  return (
    <>
      {fiscalOn && rows.length > 0 && (
        <label className="check">
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
          <span>Solo sin factura ({pendingCount})</span>
        </label>
      )}
      {shown.length === 0 ? (
        <div className="empty">
          <h2>{onlyPending ? 'Todas las comandas tienen factura' : 'No hay comandas cerradas en los últimos 7 días'}</h2>
        </div>
      ) : (
        <div className="list">
          {shown.map(({ order, tableName, invoice }) => (
            <div key={order.id} className="list-row closed-row">
              <button className="closed-main" onClick={() => navigate(`/comanda/${order.id}`)}>
                <span className="product-line">
                  <span>{orderTitle(order, tableName)}</span>
                  <span className="product-sub">
                    {order.number ? `#${order.number} · ` : ''}
                    {order.closed_at ? closedFmt.format(new Date(order.closed_at)) : ''}
                    {invoice && ` · ${cbteLabel[invoice.cbte_type]?.name ?? 'Factura'} ${invoiceNumber(invoice)}`}
                  </span>
                </span>
                <span className="price">{formatMoney(order.total)}</span>
              </button>
              {invoice ? (
                <button className="btn btn-quiet btn-small" onClick={() => navigate(`/factura/${invoice.id}`)}>Ver factura</button>
              ) : fiscalOn && order.total > 0 ? (
                <button className="btn btn-quiet btn-small" onClick={() => void startInvoice(order)}>Facturar</button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {fiscalOn && <p className="hint muted">La factura sale con la fecha de hoy.</p>}

      {invoicing && (
        <Sheet
          title={`Facturar ${orderTitle(invoicing.order, rows.find((r) => r.order.id === invoicing.order.id)?.tableName)}`}
          aside={<span className="price">{formatMoney(invoicing.order.total)}</span>}
          onClose={() => setInvoicing(null)}
        >
          <InvoiceForm
            orderId={invoicing.order.id}
            total={invoicing.order.total}
            customer={invoicing.customer}
            onDone={(inv) => navigate(`/factura/${inv.id}`)}
            onSkip={() => setInvoicing(null)}
          />
        </Sheet>
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
