import { useEffect, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { cachedQuery } from '../lib/offline'
import { updateOrder, type Order } from '../lib/orders'
import { roleLabel, formatMoney } from '../lib/format'
import type { TeamMember } from '../lib/team'
import type { Tables } from '../lib/database.types'
import { Sheet } from './Sheet'
import { useNavigate } from 'react-router-dom'
import { useCustomers } from '../lib/customers'
import { CustomerForm } from './CustomerForm'
import { useCurrentRestaurant } from '../lib/restaurant'

type Table = Tables<'tables'>
type View = 'menu' | 'move' | 'merge' | 'waiter' | 'customer' | 'new-customer'

/** Opciones de una mesa abierta: pasar a otra mesa, unir mesas, mozo y comensales. */
export function OrderActions({
  order,
  tableName,
  team,
  online,
  onClose,
  onChanged,
}: {
  order: Order
  tableName: string | null
  team: TeamMember[]
  online: boolean
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const rid = order.restaurant_id
  const navigate = useNavigate()
  const dineIn = order.type === 'dine_in'
  const { role } = useCurrentRestaurant()
  const canCreateCustomer = ['owner', 'manager', 'cashier'].includes(role)
  const { customers, reload: reloadCustomers } = useCustomers(rid)
  const [customerQuery, setCustomerQuery] = useState('')
  const customer = customers.find((c) => c.id === order.customer_id)
  const [view, setView] = useState<View>('menu')
  const [tables, setTables] = useState<Table[]>([])
  const [open, setOpen] = useState<Order[]>([])
  const [guests, setGuests] = useState(order.guests ?? 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const [t, o] = await Promise.all([
        cachedQuery<Table>(`salon:${rid}:tables`, 'tables', [], () =>
          supabase.from('tables').select('*').eq('restaurant_id', rid).eq('active', true).order('sort_order'),
        ),
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
      ])
      setTables(t.data)
      setOpen(o.data.filter((x) => x.id !== order.id))
    }
    void load()
  }, [rid, order.id])

  const label = dineIn ? `Mesa ${tableName ?? '?'}` : `Comanda #${order.number ?? ''}`
  const busyTables = new Set(open.map((o) => o.table_id))
  const freeTables = tables.filter((t) => t.id !== order.table_id && !busyTables.has(t.id))
  const tableOf = (id: string | null) => tables.find((t) => t.id === id)?.name ?? '?'
  const waiter = team.find((m) => m.user_id === order.waiter_id)

  async function run(fn: () => PromiseLike<{ error: unknown }>, done = true) {
    setBusy(true)
    setError(null)
    const { error } = await fn()
    setBusy(false)
    if (error) return setError(errorMessage(error))
    await onChanged()
    if (done) onClose()
  }

  const title = {
    menu: `Opciones · ${label}`,
    move: 'Pasar a otra mesa',
    merge: 'Unir con otra mesa',
    waiter: 'Mozo de la mesa',
    customer: 'Cliente de la comanda',
    'new-customer': 'Nuevo cliente',
  }[view]
  const q = customerQuery.trim().toLocaleLowerCase('es')
  const matches = customers.filter((c) => c.active && (!q || c.name.toLocaleLowerCase('es').includes(q) || (c.doc_number ?? '').includes(q)))

  return (
    <Sheet title={title} onClose={onClose}>
      {view === 'menu' && (
        <div className="list">
          <button className="list-row" onClick={() => navigate(`/imprimir/precuenta/${order.id}`)}>
            <span>Imprimir precuenta</span>
            <span className="muted">Para llevar a la mesa</span>
          </button>
          <button className="list-row" onClick={() => navigate(`/imprimir/cocina/${order.id}`)}>
            <span>Imprimir comanda de cocina</span>
            <span className="muted">Por estación, sin precios</span>
          </button>
          {dineIn && (
            <>
              <button className="list-row" onClick={() => setView('move')}>
                <span>Pasar a otra mesa</span>
                <span className="muted">Mueve todo el pedido</span>
              </button>
              <button className="list-row" onClick={() => setView('merge')} disabled={!online}>
                <span>Unir con otra mesa</span>
                <span className="muted">{online ? 'Junta dos pedidos en uno' : 'Necesita conexión'}</span>
              </button>
            </>
          )}
          <button className="list-row" onClick={() => setView('customer')}>
            <span>Cliente</span>
            <span className="muted">{customer?.name ?? 'Para facturar con sus datos o cargar a cuenta'}</span>
          </button>
          <button className="list-row" onClick={() => setView('waiter')}>
            <span>Mozo</span>
            <span className="muted">{waiter?.name ?? 'Sin asignar'}</span>
          </button>
          <div className="list-row">
            <span>Comensales</span>
            <span className="stepper">
              <button aria-label="Un comensal menos" disabled={guests <= 0 || busy} onClick={() => setGuests((g) => Math.max(0, g - 1))}>−</button>
              <span>{guests}</span>
              <button aria-label="Un comensal más" disabled={busy} onClick={() => setGuests((g) => g + 1)}>+</button>
            </span>
          </div>
          {guests !== (order.guests ?? 0) && (
            <div className="list-row">
              <button
                className="btn btn-primary btn-block"
                disabled={busy}
                onClick={() => void run(() => updateOrder(order.id, { guests: guests || null }, `${label}: ${guests} comensales`))}
              >
                Guardar comensales
              </button>
            </div>
          )}
        </div>
      )}

      {view === 'move' && (
        <>
          <p className="muted">Elegí una mesa libre. El pedido, lo enviado a cocina y los pagos pasan tal cual.</p>
          {freeTables.length === 0 ? (
            <p className="muted">No hay mesas libres.</p>
          ) : (
            <div className="table-picker">
              {freeTables.map((t) => (
                <button
                  key={t.id}
                  className="table-tile small"
                  disabled={busy}
                  onClick={() => void run(() => updateOrder(order.id, { table_id: t.id }, `${label}: pasar a la mesa ${t.name}`))}
                  aria-label={`Pasar a la mesa ${t.name}`}
                >
                  <span className="num">{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'merge' && (
        <>
          <p className="muted">El pedido de la mesa que elijas se suma a esta y esa mesa queda libre.</p>
          {open.length === 0 ? (
            <p className="muted">No hay otras mesas abiertas.</p>
          ) : (
            <div className="list">
              {open.map((o) => (
                <button
                  key={o.id}
                  className="list-row"
                  disabled={busy || o.paid_total > 0}
                  onClick={() => void run(() => supabase.rpc('merge_orders', { p_target: order.id, p_source: o.id }))}
                  aria-label={`Unir la mesa ${tableOf(o.table_id)}`}
                >
                  <span className="product-line">
                    <span>Mesa {tableOf(o.table_id)}</span>
                    <span className="product-sub">{o.paid_total > 0 ? 'Tiene pagos: no se puede unir' : `Comanda #${o.number ?? '—'}`}</span>
                  </span>
                  <span className="nowrap">{formatMoney(o.total)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'waiter' && (
        <div className="list">
          {team
            .filter((m) => m.role !== 'kitchen')
            .map((m) => (
              <button
                key={m.user_id}
                className="list-row"
                disabled={busy}
                aria-pressed={m.user_id === order.waiter_id}
                onClick={() => void run(() => updateOrder(order.id, { waiter_id: m.user_id }, `${label}: mozo ${m.name}`))}
              >
                <span>{m.name}</span>
                <span className={m.user_id === order.waiter_id ? 'badge' : 'muted'}>
                  {m.user_id === order.waiter_id ? 'Asignado' : roleLabel[m.role]}
                </span>
              </button>
            ))}
        </div>
      )}

      {view === 'customer' && (
        <>
          <input
            className="search"
            type="search"
            placeholder="Buscar cliente"
            aria-label="Buscar cliente"
            value={customerQuery}
            onChange={(e) => setCustomerQuery(e.target.value)}
          />
          <div className="list">
            {matches.slice(0, 30).map((c) => (
              <button
                key={c.id}
                className="list-row"
                disabled={busy}
                aria-pressed={c.id === order.customer_id}
                onClick={() => void run(() => updateOrder(order.id, { customer_id: c.id }, `${label}: cliente ${c.name}`))}
              >
                <span>{c.name}</span>
                <span className={c.id === order.customer_id ? 'badge' : 'muted'}>
                  {c.id === order.customer_id ? 'Asignado' : c.doc_number ?? ''}
                </span>
              </button>
            ))}
            {matches.length === 0 && <div className="list-row"><span className="muted">No hay clientes que coincidan.</span></div>}
          </div>
          <div className="sheet-actions">
            {canCreateCustomer && (
              <button className="btn btn-quiet" onClick={() => setView('new-customer')}>Nuevo cliente</button>
            )}
            {order.customer_id && (
              <button className="btn btn-quiet" disabled={busy} onClick={() => void run(() => updateOrder(order.id, { customer_id: null }, `${label}: quitar cliente`))}>
                Quitar cliente
              </button>
            )}
          </div>
        </>
      )}

      {view === 'new-customer' && (
        <CustomerForm
          restaurantId={rid}
          onCancel={() => setView('customer')}
          onSaved={(c) => {
            void reloadCustomers()
            void run(() => updateOrder(order.id, { customer_id: c.id }, `${label}: cliente ${c.name}`))
          }}
        />
      )}

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      <div className="sheet-actions">
        {view === 'menu' ? (
          <button className="btn btn-quiet" onClick={onClose}>Cerrar</button>
        ) : view !== 'new-customer' ? (
          <button className="btn btn-quiet" onClick={() => setView('menu')}>Volver</button>
        ) : null}
      </div>
    </Sheet>
  )
}
