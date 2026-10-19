import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { useMenu, validateSelection, type ProductWithGroups } from '../lib/menu'
import { itemModifiers, itemStatusLabel, modifierIds, orderTitle, useOrder, type OrderItem } from '../lib/orders'
import { formatMoney } from '../lib/format'
import { Sheet } from '../components/Sheet'
import { PaySheet } from '../components/PaySheet'

const FAVORITES = '__favoritos__'

export function Comanda() {
  const { orderId = '' } = useParams()
  const { restaurant, role } = useCurrentRestaurant()
  const { order, items, payments, tableName, loading, error, reload } = useOrder(orderId)
  const navigate = useNavigate()
  const [paying, setPaying] = useState(false)
  const { menu, loading: menuLoading } = useMenu(restaurant.id)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<ProductWithGroups | null>(null)
  const [editingItem, setEditingItem] = useState<OrderItem | null>(null)
  const [ticketOpen, setTicketOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const canSell = ['owner', 'manager', 'cashier', 'waiter'].includes(role)
  const isOpen = order?.status === 'open'
  const editable = canSell && isOpen

  const favorites = menu.products.filter((p) => p.is_favorite)
  const activeTab = tab ?? (favorites.length ? FAVORITES : menu.categories[0]?.id ?? null)

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('es')
    if (q) return menu.products.filter((p) => p.name.toLocaleLowerCase('es').includes(q))
    if (activeTab === FAVORITES) return favorites
    if (activeTab) return menu.products.filter((p) => p.category_id === activeTab)
    return menu.products
  }, [query, activeTab, menu.products, favorites])

  const pending = items.filter((i) => i.status === 'pending')
  const sent = items.filter((i) => i.status !== 'pending')
  const pendingTotal = pending.reduce((s, i) => s + (i.line_total ?? 0), 0)
  const pendingUnits = pending.reduce((s, i) => s + i.quantity, 0)
  const sentUnits = sent.filter((i) => i.status !== 'cancelled').reduce((s, i) => s + i.quantity, 0)

  async function act(fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(true)
    setActionError(null)
    const { error } = await fn()
    if (error) setActionError(errorMessage(error))
    await reload()
    setBusy(false)
    return !error
  }

  async function addProduct(p: ProductWithGroups, mods: string[] = [], quantity = 1, notes: string | null = null) {
    // Mismo producto sin opciones ni nota y todavía sin enviar: se suma la cantidad
    const same = mods.length === 0 && !notes
      ? pending.find((i) => i.product_id === p.id && itemModifiers(i).length === 0 && !i.notes)
      : undefined
    return act(() =>
      same
        ? supabase.from('order_items').update({ quantity: same.quantity + quantity }).eq('id', same.id)
        : supabase.from('order_items').insert({
            restaurant_id: restaurant.id,
            order_id: orderId,
            product_id: p.id,
            name: p.name,
            unit_price: p.price,
            quantity,
            notes,
            modifiers: modifierIds(mods),
          }),
    )
  }

  function pick(p: ProductWithGroups) {
    if (!editable) return
    if (p.groups.some((g) => g.modifiers.length > 0)) setChoosing(p)
    else void addProduct(p)
  }

  async function sendToKitchen() {
    const ok = await act(() =>
      supabase.from('order_items').update({ status: 'sent' }).eq('order_id', orderId).eq('status', 'pending'),
    )
    if (ok) setTicketOpen(false)
  }

  if (loading) return <div className="center-screen">Cargando la comanda…</div>
  if (!order)
    return (
      <div className="content">
        <div className="empty">
          <h2>No encontramos esta comanda</h2>
          <p className="muted">Puede que se haya cerrado o que no tengas acceso.</p>
          <Link className="btn btn-quiet" to="/comandas">Ver comandas abiertas</Link>
        </div>
      </div>
    )

  const ticket = (
    <Ticket
      pending={pending}
      sent={sent}
      total={order.total}
      pendingTotal={pendingTotal}
      editable={editable}
      busy={busy}
      onEdit={setEditingItem}
      onQuantity={(item, q) =>
        void act(() =>
          q <= 0
            ? supabase.from('order_items').delete().eq('id', item.id)
            : supabase.from('order_items').update({ quantity: q }).eq('id', item.id),
        )
      }
      onSend={sendToKitchen}
      onPay={
        canSell && isOpen && items.some((i) => i.status !== 'cancelled')
          ? () => {
              setTicketOpen(false)
              setPaying(true)
            }
          : undefined
      }
    />
  )

  return (
    <div className="order-page">
      <header className="order-head">
        <Link to={order.type === 'dine_in' ? '/salon' : '/comandas'} className="back-link">
          Volver
        </Link>
        <div>
          <h1>{orderTitle(order, tableName)}</h1>
          <span className="muted">
            Comanda #{order.number}
            {!isOpen && ` · ${order.status === 'closed' ? 'cerrada' : 'anulada'}`}
          </span>
        </div>
      </header>

      {(error || actionError) && (
        <div className="content">
          <div className="notice notice-error" role="alert">{actionError ?? error}</div>
        </div>
      )}

      <div className="order-layout">
        <section className="picker" aria-label="Carta">
          {editable ? (
            <>
              <input
                className="search"
                type="search"
                placeholder="Buscar en la carta"
                aria-label="Buscar en la carta"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {!query && (
                <div className="areas" role="group" aria-label="Categorías">
                  {favorites.length > 0 && (
                    <button aria-pressed={activeTab === FAVORITES} onClick={() => setTab(FAVORITES)}>Favoritos</button>
                  )}
                  {menu.categories.map((c) => (
                    <button key={c.id} aria-pressed={activeTab === c.id} onClick={() => setTab(c.id)}>
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              {menuLoading ? (
                <p className="muted">Cargando la carta…</p>
              ) : menu.products.length === 0 ? (
                <div className="empty">
                  <h2>La carta está vacía</h2>
                  <p className="muted">
                    {role === 'owner' || role === 'manager'
                      ? 'Cargá productos desde Más → Carta para empezar a tomar pedidos.'
                      : 'Pedile al encargado que cargue la carta.'}
                  </p>
                </div>
              ) : shown.length === 0 ? (
                <p className="muted">No hay productos que coincidan.</p>
              ) : (
                <div className="product-grid">
                  {shown.map((p) => (
                    <button key={p.id} className="product-tile" onClick={() => pick(p)} disabled={busy}>
                      <span className="name">{p.name}</span>
                      <span className="price">{formatMoney(p.price)}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="muted">
              {isOpen ? 'Tu rol no permite cargar productos.' : 'La comanda ya no admite cambios.'}
            </p>
          )}
        </section>

        <aside className="ticket-pane" aria-label="Pedido">{ticket}</aside>
      </div>

      {/* Celular: barra con el resumen; abre el pedido completo */}
      <div className="order-bar">
        <div>
          <strong>{pendingUnits ? `${pendingUnits} por enviar` : `${sentUnits} ${sentUnits === 1 ? 'enviado' : 'enviados'}`}</strong>
          <span className="muted"> · {formatMoney(order.total)}</span>
        </div>
        <button className="btn btn-primary" onClick={() => setTicketOpen(true)}>Ver pedido</button>
      </div>

      {ticketOpen && (
        <Sheet title="Pedido" onClose={() => setTicketOpen(false)}>
          {ticket}
          <button className="btn btn-quiet" onClick={() => setTicketOpen(false)}>
            {editable ? 'Seguir cargando' : 'Cerrar'}
          </button>
        </Sheet>
      )}

      {paying && (
        <PaySheet
          order={order}
          payments={payments}
          role={role}
          pendingItems={pendingUnits}
          onClose={() => setPaying(false)}
          onChanged={reload}
          onClosedOrder={() => navigate(order.type === 'dine_in' ? '/salon' : '/comandas')}
        />
      )}

      {choosing && (
        <ModifierSheet
          product={choosing}
          busy={busy}
          onClose={() => setChoosing(null)}
          onAdd={async (mods, qty, notes) => {
            if (await addProduct(choosing, mods, qty, notes)) setChoosing(null)
          }}
        />
      )}

      {editingItem && (
        <ItemSheet
          item={items.find((i) => i.id === editingItem.id) ?? editingItem}
          editable={editable}
          canDeliver={canSell}
          busy={busy}
          onClose={() => setEditingItem(null)}
          onDeliver={async () => {
            if (await act(() => supabase.from('order_items').update({ status: 'delivered' }).eq('id', editingItem.id)))
              setEditingItem(null)
          }}
          onSaveNote={async (notes) => {
            if (await act(() => supabase.from('order_items').update({ notes }).eq('id', editingItem.id))) setEditingItem(null)
          }}
          onRemove={async () => {
            if (await act(() => supabase.from('order_items').delete().eq('id', editingItem.id))) setEditingItem(null)
          }}
          onCancel={async () => {
            if (await act(() => supabase.from('order_items').update({ status: 'cancelled' }).eq('id', editingItem.id)))
              setEditingItem(null)
          }}
        />
      )}
    </div>
  )
}

function Ticket({
  pending,
  sent,
  total,
  pendingTotal,
  editable,
  busy,
  onEdit,
  onQuantity,
  onSend,
  onPay,
}: {
  pending: OrderItem[]
  sent: OrderItem[]
  total: number
  pendingTotal: number
  editable: boolean
  busy: boolean
  onEdit: (i: OrderItem) => void
  onQuantity: (i: OrderItem, q: number) => void
  onSend: () => void
  onPay?: () => void
}) {
  return (
    <div className="ticket order-ticket">
      {pending.length === 0 && sent.length === 0 && <p className="muted">Todavía no hay productos. Elegilos de la carta.</p>}

      {pending.length > 0 && (
        <div className="ticket-group">
          <div className="ticket-group-head">Por enviar</div>
          {pending.map((i) => (
            <div key={i.id} className="ticket-item">
              <button className="item-main" onClick={() => onEdit(i)} aria-label={`Editar ${i.name}`}>
                <ItemText item={i} />
              </button>
              {editable && (
                <div className="stepper" aria-label={`Cantidad de ${i.name}`}>
                  <button onClick={() => onQuantity(i, i.quantity - 1)} disabled={busy} aria-label="Uno menos">−</button>
                  <span>{i.quantity}</span>
                  <button onClick={() => onQuantity(i, i.quantity + 1)} disabled={busy} aria-label="Uno más">+</button>
                </div>
              )}
              <span className="amount">{formatMoney(i.line_total)}</span>
            </div>
          ))}
        </div>
      )}

      {sent.length > 0 && (
        <div className="ticket-group">
          <div className="ticket-group-head">En cocina y entregado</div>
          {sent.map((i) => (
            <div key={i.id} className={`ticket-item${i.status === 'cancelled' ? ' cancelled' : ''}`}>
              <button className="item-main" onClick={() => onEdit(i)} aria-label={`Ver ${i.name}`}>
                <ItemText item={i} />
                <span className={`status status-${i.status}`}>{itemStatusLabel[i.status]}</span>
              </button>
              <span className="qty">×{i.quantity}</span>
              <span className="amount">{formatMoney(i.status === 'cancelled' ? 0 : i.line_total)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="ticket-row ticket-total">
        <span>Total</span>
        <span className="amount">{formatMoney(total)}</span>
      </div>

      {editable && (
        <button className="btn btn-primary btn-block" onClick={onSend} disabled={busy || pending.length === 0}>
          {pending.length ? `Enviar a cocina · ${formatMoney(pendingTotal)}` : 'Nada por enviar'}
        </button>
      )}
      {onPay && (
        <button className={`btn btn-block ${pending.length ? 'btn-quiet' : 'btn-primary'}`} onClick={onPay} disabled={busy}>
          Cobrar · {formatMoney(total)}
        </button>
      )}
    </div>
  )
}

function ItemText({ item }: { item: OrderItem }) {
  const mods = itemModifiers(item)
  return (
    <span className="item-text">
      <span className="item-name">{item.name}</span>
      {mods.length > 0 && <span className="item-detail">{mods.map((m) => m.name).join(', ')}</span>}
      {item.notes && <span className="item-detail item-note">{item.notes}</span>}
    </span>
  )
}

function ModifierSheet({
  product,
  busy,
  onClose,
  onAdd,
}: {
  product: ProductWithGroups
  busy: boolean
  onClose: () => void
  onAdd: (mods: string[], qty: number, notes: string | null) => void
}) {
  const groups = product.groups.filter((g) => g.modifiers.length > 0)
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Preselecciona la primera opción de los grupos obligatorios de una sola opción
    const init = new Set<string>()
    for (const g of groups) if (g.min_select === 1 && g.max_select === 1 && g.modifiers[0]) init.add(g.modifiers[0].id)
    return init
  })
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  function toggle(groupId: string, modId: string, single: boolean) {
    setSelected((cur) => {
      const next = new Set(cur)
      const group = groups.find((g) => g.id === groupId)
      if (single && group) for (const m of group.modifiers) next.delete(m.id)
      if (cur.has(modId) && !single) next.delete(modId)
      else next.add(modId)
      return next
    })
  }

  const extra = groups.flatMap((g) => g.modifiers).filter((m) => selected.has(m.id)).reduce((s, m) => s + m.price_delta, 0)

  function submit() {
    const problem = validateSelection(groups, selected)
    if (problem) return setError(problem)
    onAdd([...selected], qty, notes.trim() || null)
  }

  return (
    <Sheet title={product.name} aside={<span className="price">{formatMoney(product.price)}</span>} onClose={onClose}>
      <div className="form">
        {groups.map((g) => {
          const single = g.max_select === 1
          return (
            <fieldset key={g.id} className="fieldset">
              <legend>
                {g.name}
                <span className="muted"> · {g.min_select > 0 ? 'obligatorio' : 'opcional'}{!single && `, hasta ${g.max_select}`}</span>
              </legend>
              {g.modifiers.map((m) => (
                <label key={m.id} className="check">
                  <input
                    type={single ? 'radio' : 'checkbox'}
                    name={`g-${g.id}`}
                    checked={selected.has(m.id)}
                    onChange={() => toggle(g.id, m.id, single)}
                  />
                  {m.name}
                  {m.price_delta !== 0 && <span className="muted"> · +{formatMoney(m.price_delta)}</span>}
                </label>
              ))}
            </fieldset>
          )
        })}
        <div className="field">
          <label htmlFor="mod-notes">Nota para cocina</label>
          <input id="mod-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej.: sin sal" />
        </div>
        <div className="qty-line">
          <span>Cantidad</span>
          <div className="stepper">
            <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Uno menos">−</button>
            <span>{qty}</span>
            <button type="button" onClick={() => setQty((q) => q + 1)} aria-label="Uno más">+</button>
          </div>
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            Agregar · {formatMoney((product.price + extra) * qty)}
          </button>
          <button className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </Sheet>
  )
}

function ItemSheet({
  item,
  editable,
  canDeliver,
  busy,
  onClose,
  onDeliver,
  onSaveNote,
  onRemove,
  onCancel,
}: {
  item: OrderItem
  editable: boolean
  canDeliver: boolean
  busy: boolean
  onClose: () => void
  onDeliver: () => void
  onSaveNote: (notes: string | null) => void
  onRemove: () => void
  onCancel: () => void
}) {
  const [notes, setNotes] = useState(item.notes ?? '')
  const isPending = item.status === 'pending'
  const mods = itemModifiers(item)

  return (
    <Sheet title={item.name} aside={<span className={`status status-${item.status}`}>{itemStatusLabel[item.status]}</span>} onClose={onClose}>
      <div className="ticket">
        <div className="ticket-row">
          <span>{item.quantity} × {formatMoney(item.unit_price + item.modifiers_total)}</span>
          <span className="amount">{formatMoney(item.line_total)}</span>
        </div>
        {mods.map((m) => (
          <div key={m.id} className="ticket-row muted">
            <span>{m.name}</span>
            <span>{m.price_delta ? `+${formatMoney(m.price_delta)}` : ''}</span>
          </div>
        ))}
      </div>

      {editable && isPending ? (
        <>
          <div className="field">
            <label htmlFor="item-notes">Nota para cocina</label>
            <input id="item-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej.: sin sal" />
          </div>
          <div className="sheet-actions">
            <button className="btn btn-primary" onClick={() => onSaveNote(notes.trim() || null)} disabled={busy}>Guardar nota</button>
            <button className="btn btn-danger" onClick={onRemove} disabled={busy}>Quitar del pedido</button>
            <button className="btn btn-quiet" onClick={onClose}>Cerrar</button>
          </div>
        </>
      ) : (
        <>
          {item.notes && <p>Nota: {item.notes}</p>}
          <div className="sheet-actions">
            {canDeliver && item.status === 'ready' && (
              <button className="btn btn-primary" onClick={onDeliver} disabled={busy}>
                Marcar entregado
              </button>
            )}
            {editable && item.status !== 'cancelled' && item.status !== 'delivered' && (
              <button className="btn btn-danger" onClick={onCancel} disabled={busy}>
                Cancelar ítem y avisar a cocina
              </button>
            )}
            <button className="btn btn-quiet" onClick={onClose}>Cerrar</button>
          </div>
        </>
      )}
    </Sheet>
  )
}
