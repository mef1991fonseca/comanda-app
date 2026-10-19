import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import { cachedQuery, onSynced, readCached, write, type WriteResult } from './offline'
import type { Enums, Json, Tables } from './database.types'

export type Order = Tables<'orders'>
export type OrderItem = Tables<'order_items'>
export type Payment = Tables<'payments'>
export type ItemStatus = Enums<'item_status'>
export type AppliedModifier = { id: string; name: string; price_delta: number }

export const itemStatusLabel: Record<ItemStatus, string> = {
  pending: 'Por enviar',
  sent: 'Enviado',
  preparing: 'En preparación',
  ready: 'Listo',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
}

export const orderTypeLabel: Record<Enums<'order_type'>, string> = {
  dine_in: 'Mesa',
  counter: 'Mostrador',
  takeaway: 'Para llevar',
  delivery: 'Delivery',
}

export function itemModifiers(item: Pick<OrderItem, 'modifiers'>): AppliedModifier[] {
  return Array.isArray(item.modifiers) ? (item.modifiers as unknown as AppliedModifier[]) : []
}

/** "Mesa 4", "Mostrador · Juan", "Para llevar #18" */
export function orderTitle(order: Order, tableName?: string | null): string {
  if (order.type === 'dine_in') return `Mesa ${tableName ?? '?'}`
  const base = orderTypeLabel[order.type]
  if (order.customer_name) return `${base} · ${order.customer_name}`
  return order.number ? `${base} #${order.number}` : base
}

/** "Comanda #12" o, si se creó sin conexión y todavía no tiene número, "Comanda nueva" */
export function orderNumberLabel(order: Pick<Order, 'number'>): string {
  return order.number ? `Comanda #${order.number}` : 'Comanda nueva (número al sincronizar)'
}

export const lineTotal = (quantity: number, unitPrice: number, modifiersTotal: number) =>
  Math.round(quantity * (unitPrice + modifiersTotal) * 100) / 100

// ---------------------------------------------------------------------------
// Escrituras de comandas: funcionan con y sin conexión (ver lib/offline.ts)
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString()

export function createOrder(input: {
  restaurantId: string
  type: Enums<'order_type'>
  tableId?: string | null
  customerName?: string | null
  label: string
}): Promise<WriteResult & { id: string }> {
  const id = crypto.randomUUID()
  const row = {
    id,
    restaurant_id: input.restaurantId,
    type: input.type,
    table_id: input.tableId ?? null,
    customer_name: input.customerName ?? null,
  }
  // Lo que se muestra mientras la comanda no llegó al servidor
  const view = {
    number: null,
    status: 'open',
    subtotal: 0,
    total: 0,
    paid_total: 0,
    discount_amount: 0,
    guests: null,
    notes: null,
    opened_at: nowIso(),
    closed_at: null,
    cash_session_id: null,
    cancelled_reason: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  return write({ table: 'orders', kind: 'insert', row, view, label: input.label }).then((r) => ({ ...r, id }))
}

export function updateOrder(orderId: string, patch: Partial<Order>, label: string) {
  return write({ table: 'orders', kind: 'update', match: { id: orderId }, patch, label })
}

export function addItem(input: {
  restaurantId: string
  orderId: string
  product: { id: string; name: string; price: number; station_id: string | null }
  modifiers: AppliedModifier[]
  quantity: number
  notes: string | null
  label: string
}) {
  const modifiersTotal = input.modifiers.reduce((s, m) => s + m.price_delta, 0)
  const total = lineTotal(input.quantity, input.product.price, modifiersTotal)
  // El servidor vuelve a tomar nombre, precio y modificadores de la carta (order_items_enrich)
  const row = {
    id: crypto.randomUUID(),
    restaurant_id: input.restaurantId,
    order_id: input.orderId,
    product_id: input.product.id,
    name: input.product.name,
    unit_price: input.product.price,
    quantity: input.quantity,
    notes: input.notes,
    modifiers: input.modifiers as unknown as Json,
    modifiers_total: modifiersTotal,
  }
  const view = {
    status: 'pending',
    line_total: total,
    station_id: input.product.station_id,
    sent_at: null,
    ready_at: null,
    guest_number: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  return write({
    table: 'order_items',
    kind: 'insert',
    row,
    view,
    deltas: [{ order_id: input.orderId, amount: total }],
    label: input.label,
  })
}

export function setItemQuantity(item: OrderItem, quantity: number, label: string) {
  const old = item.line_total ?? 0
  if (quantity <= 0) {
    return write({ table: 'order_items', kind: 'delete', match: { id: item.id }, deltas: [{ order_id: item.order_id, amount: -old }], label })
  }
  const next = lineTotal(quantity, item.unit_price, item.modifiers_total)
  return write({
    table: 'order_items',
    kind: 'update',
    match: { id: item.id },
    patch: { quantity },
    view: { line_total: next, updated_at: nowIso() },
    deltas: [{ order_id: item.order_id, amount: next - old }],
    label,
  })
}

export function updateItem(item: OrderItem, patch: Partial<OrderItem>, label: string) {
  const cancelling = patch.status === 'cancelled' && item.status !== 'cancelled'
  const view: Record<string, unknown> = { updated_at: nowIso() }
  if (patch.status === 'sent' || patch.status === 'preparing') view.sent_at = item.sent_at ?? nowIso()
  if (patch.status === 'ready' || patch.status === 'delivered') view.ready_at = item.ready_at ?? nowIso()
  return write({
    table: 'order_items',
    kind: 'update',
    match: { id: item.id },
    patch,
    view,
    deltas: cancelling ? [{ order_id: item.order_id, amount: -(item.line_total ?? 0) }] : undefined,
    label,
  })
}

export function removeItem(item: OrderItem, label: string) {
  return write({
    table: 'order_items',
    kind: 'delete',
    match: { id: item.id },
    deltas: [{ order_id: item.order_id, amount: -(item.line_total ?? 0) }],
    label,
  })
}

export function sendPending(orderId: string, label: string) {
  return write({
    table: 'order_items',
    kind: 'update',
    match: { order_id: orderId, status: 'pending' },
    patch: { status: 'sent' },
    view: { sent_at: nowIso(), updated_at: nowIso() },
    label,
  })
}

/** Cambio de estado de cocina para varios ítems a la vez */
export function setItemsStatus(ids: string[], status: ItemStatus, label: string) {
  const view: Record<string, unknown> = { updated_at: nowIso() }
  if (status === 'ready') view.ready_at = nowIso()
  return write({ table: 'order_items', kind: 'update', match: { id: ids }, patch: { status }, view, label })
}

// ---------------------------------------------------------------------------
// Lectura de una comanda (con caché y en tiempo real)
// ---------------------------------------------------------------------------

/** Recarga cuando termina una sincronización que aplicó cambios pendientes. */
export function useSyncedReload(reload: () => unknown) {
  useEffect(() => onSynced(() => void reload()), [reload])
}

/** Comanda + ítems + pagos, en tiempo real y disponible sin conexión. */
export function useOrder(orderId: string) {
  const [order, setOrder] = useState<Order | null>(null)
  const [items, setItems] = useState<OrderItem[]>([])
  const [tableName, setTableName] = useState<string | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [offline, setOffline] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [o, i, p] = await Promise.all([
      cachedQuery<Order>(`order:${orderId}`, 'orders', [{ col: 'id', op: 'eq', value: orderId }], () =>
        supabase.from('orders').select('*').eq('id', orderId),
      ),
      cachedQuery<OrderItem>(`order:${orderId}:items`, 'order_items', [{ col: 'order_id', op: 'eq', value: orderId }], () =>
        supabase.from('order_items').select('*').eq('order_id', orderId).order('created_at'),
      ),
      cachedQuery<Payment>(`order:${orderId}:payments`, 'payments', [{ col: 'order_id', op: 'eq', value: orderId }], () =>
        supabase.from('payments').select('*').eq('order_id', orderId).order('created_at'),
      ),
    ])
    const current = o.data[0] ?? null
    if (o.error && !current) {
      setError(errorMessage(o.error))
    } else {
      setError(null)
      setOrder(current)
      setItems(i.data)
      setPayments(p.data)
      setOffline(o.fromCache)
      if (current?.table_id) {
        const tableId = current.table_id
        const t = await cachedQuery<{ id: string; name: string }>(`table:${tableId}`, 'tables', [], () =>
          supabase.from('tables').select('id, name').eq('id', tableId),
        )
        // Sin conexión, la mesa sale de lo que guardó el Salón
        const fromSalon = t.data[0]
          ? null
          : (await readCached<{ id: string; name: string }>(`salon:${current.restaurant_id}:tables`)).find((x) => x.id === tableId)
        setTableName(t.data[0]?.name ?? fromSalon?.name ?? null)
      }
    }
    setLoading(false)
  }, [orderId])

  useSyncedReload(reload)

  useEffect(() => {
    void reload()
    const channel = supabase
      .channel(`order-${orderId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `order_id=eq.${orderId}` }, () => {
        void reload()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` }, () => {
        void reload()
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [orderId, reload])

  return { order, items, payments, tableName, offline, loading, error, reload }
}
