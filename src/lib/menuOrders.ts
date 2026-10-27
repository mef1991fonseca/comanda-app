import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import type { Tables } from './database.types'

export type MenuOrderLine = {
  product_id: string
  name: string
  quantity: number
  unit_price: number
  modifiers: { id: string; name: string; price_delta: number }[]
  notes: string | null
}
export type MenuOrder = Omit<Tables<'menu_orders'>, 'items'> & { items: MenuOrderLine[]; table_name: string }

/** Cuánto atrás miramos pedidos esperando (los más viejos ya no tienen sentido). */
const WINDOW_HOURS = 6

/** Pedidos de la carta QR esperando que alguien del salón los acepte. Realtime + consulta cada 15 s. */
export function usePendingMenuOrders(restaurantId: string, enabled: boolean) {
  const [orders, setOrders] = useState<MenuOrder[]>([])

  const load = useCallback(async () => {
    if (!enabled || !navigator.onLine) return
    const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString()
    const [{ data }, { data: tables }] = await Promise.all([
      supabase
        .from('menu_orders')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .eq('status', 'pending')
        .gte('created_at', since)
        .order('created_at'),
      supabase.from('tables').select('id, name').eq('restaurant_id', restaurantId),
    ])
    const names = new Map((tables ?? []).map((t) => [t.id, t.name]))
    setOrders(
      (data ?? []).map((o) => ({
        ...o,
        items: (o.items as unknown as MenuOrderLine[]) ?? [],
        table_name: names.get(o.table_id) ?? '?',
      })),
    )
  }, [restaurantId, enabled])

  useEffect(() => {
    if (!enabled) {
      setOrders([])
      return
    }
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    const channel = supabase
      .channel(`menu-orders-${restaurantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_orders', filter: `restaurant_id=eq.${restaurantId}` }, () => void load())
      .subscribe()
    const online = () => void load()
    window.addEventListener('online', online)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', online)
      void supabase.removeChannel(channel)
    }
  }, [restaurantId, enabled, load])

  return { orders, reload: load }
}

export async function acceptMenuOrder(id: string): Promise<{ orderId?: string; error?: string }> {
  const { data, error } = await supabase.rpc('accept_menu_order', { p_id: id })
  if (error) return { error: errorMessage(error) }
  return { orderId: data }
}

export async function rejectMenuOrder(id: string, reason: string | null): Promise<string | null> {
  const { error } = await supabase.rpc('reject_menu_order', { p_id: id, p_reason: reason ?? undefined })
  return error ? errorMessage(error) : null
}

