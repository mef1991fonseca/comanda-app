import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import type { Enums } from './database.types'

export type SalesReport = {
  totals: { orders: number; sales: number; subtotal: number; discounts: number; tips: number }
  by_hour: { hour: number; sales: number; orders: number }[]
  by_day: { day: string; sales: number; orders: number }[]
  by_payment: { method: string; kind: Enums<'payment_kind'>; amount: number; tips: number; count: number }[]
  by_type: { type: Enums<'order_type'>; sales: number; orders: number }[]
  products: { product_id: string | null; name: string; qty: number; revenue: number; cost: number; costed_revenue: number | null; has_recipe: boolean }[]
}

export type RangeKey = 'today' | 'yesterday' | 'week' | 'month'

export const rangeLabel: Record<RangeKey, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  week: 'Últimos 7 días',
  month: 'Este mes',
}

/** Rango [desde, hasta) en la hora local del dispositivo (el local opera en su zona). */
export function rangeFor(key: RangeKey, now = new Date()): { from: Date; to: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = 24 * 60 * 60 * 1000
  switch (key) {
    case 'today':
      return { from: start, to: new Date(start.getTime() + day) }
    case 'yesterday':
      return { from: new Date(start.getTime() - day), to: start }
    case 'week':
      return { from: new Date(start.getTime() - 6 * day), to: new Date(start.getTime() + day) }
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(start.getTime() + day) }
  }
}

export function useSalesReport(restaurantId: string, range: { from: Date; to: Date }) {
  const [report, setReport] = useState<SalesReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fromIso = range.from.toISOString()
  const toIso = range.to.toISOString()

  const reload = useCallback(async () => {
    const { data, error } = await supabase.rpc('sales_report', { p_restaurant: restaurantId, p_from: fromIso, p_to: toIso })
    if (error) setError(errorMessage(error))
    else {
      setReport(data as unknown as SalesReport)
      setError(null)
    }
    setLoading(false)
  }, [restaurantId, fromIso, toIso])

  useEffect(() => {
    setLoading(true)
    void reload()
  }, [reload])

  return { report, loading, error, reload }
}
