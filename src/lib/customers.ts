import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import { formatMoney } from './format'
import type { Tables } from './database.types'

export type Customer = Tables<'customers'>
export type CustomerWithBalance = Customer & { balance: number }
export type CustomerMovement = Tables<'customer_movements'>

export const movementLabel: Record<CustomerMovement['kind'], string> = {
  charge: 'Consumo a cuenta',
  payment: 'Pago',
  reversal: 'Consumo anulado',
}

/** "Debe $ 12.000" · "A favor $ 500" · "Al día" */
export function balanceText(balance: number) {
  if (balance > 0.009) return `Debe ${formatMoney(balance)}`
  if (balance < -0.009) return `A favor ${formatMoney(-balance)}`
  return 'Al día'
}

/** Clientes del local con su saldo (el saldo solo lo ven dueño, encargado y cajero). */
export function useCustomers(restaurantId: string) {
  const [customers, setCustomers] = useState<CustomerWithBalance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [c, b] = await Promise.all([
      supabase.from('customers').select('*').eq('restaurant_id', restaurantId).order('name'),
      supabase.from('customer_balances').select('id, balance').eq('restaurant_id', restaurantId),
    ])
    if (c.error) {
      setError(errorMessage(c.error))
    } else {
      const balances = new Map((b.data ?? []).map((x) => [x.id, Number(x.balance)]))
      setCustomers(c.data.map((x) => ({ ...x, balance: balances.get(x.id) ?? 0 })))
      setError(null)
    }
    setLoading(false)
  }, [restaurantId])

  useEffect(() => {
    void reload()
  }, [reload])

  return { customers, loading, error, reload }
}
