import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import type { Enums, Json, Tables } from './database.types'

export type Order = Tables<'orders'>
export type OrderItem = Tables<'order_items'>
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

export function modifierIds(ids: string[]): Json {
  return ids.map((id) => ({ id }))
}

/** "Mesa 4", "Mostrador · Juan", "Para llevar #18" */
export function orderTitle(order: Order, tableName?: string | null): string {
  if (order.type === 'dine_in') return `Mesa ${tableName ?? '?'}`
  const base = orderTypeLabel[order.type]
  return order.customer_name ? `${base} · ${order.customer_name}` : `${base} #${order.number ?? ''}`
}

/** Comanda + ítems en tiempo real. */
export function useOrder(orderId: string) {
  const [order, setOrder] = useState<Order | null>(null)
  const [items, setItems] = useState<OrderItem[]>([])
  const [tableName, setTableName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [o, i] = await Promise.all([
      supabase.from('orders').select('*').eq('id', orderId).maybeSingle(),
      supabase.from('order_items').select('*').eq('order_id', orderId).order('created_at'),
    ])
    if (o.error || i.error) {
      setError(errorMessage(o.error ?? i.error))
    } else {
      setError(null)
      setOrder(o.data)
      setItems(i.data)
      if (o.data?.table_id) {
        const t = await supabase.from('tables').select('name').eq('id', o.data.table_id).maybeSingle()
        setTableName(t.data?.name ?? null)
      }
    }
    setLoading(false)
  }, [orderId])

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

  return { order, items, tableName, loading, error, reload }
}
