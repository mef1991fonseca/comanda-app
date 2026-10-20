import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import { formatMoney } from './format'
import type { Enums, Tables } from './database.types'

export type Supplier = Tables<'suppliers'>
export type SupplierWithBalance = Supplier & { balance: number }
export type Purchase = Tables<'purchases'>
export type PurchaseItem = Tables<'purchase_items'>
export type SupplierMovement = Tables<'supplier_movements'>
export type ExpenseCategory = Enums<'expense_category'>

export const categoryLabel: Record<ExpenseCategory, string> = {
  mercaderia: 'Mercadería',
  bebidas: 'Bebidas',
  descartables: 'Descartables y limpieza',
  servicios: 'Servicios (luz, gas, internet)',
  alquiler: 'Alquiler',
  sueldos: 'Sueldos',
  impuestos: 'Impuestos',
  mantenimiento: 'Mantenimiento',
  otros: 'Otros',
}

export const docKindLabel: Record<string, string> = {
  factura_a: 'Factura A',
  factura_b: 'Factura B',
  factura_c: 'Factura C',
  factura: 'Factura',
  remito: 'Remito',
  ticket: 'Ticket',
  otro: 'Otro',
}

export const supplierMovementLabel: Record<SupplierMovement['kind'], string> = {
  purchase: 'Compra',
  payment: 'Pago',
  reversal: 'Compra anulada',
}

/** "Le debés $ 12.000" · "A favor $ 500" · "Al día" */
export function supplierBalanceText(balance: number) {
  if (balance > 0.009) return `Le debés ${formatMoney(balance)}`
  if (balance < -0.009) return `A favor ${formatMoney(-balance)}`
  return 'Al día'
}

export function useSuppliers(restaurantId: string) {
  const [suppliers, setSuppliers] = useState<SupplierWithBalance[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [s, b] = await Promise.all([
      supabase.from('suppliers').select('*').eq('restaurant_id', restaurantId).order('name'),
      supabase.from('supplier_balances').select('id, balance').eq('restaurant_id', restaurantId),
    ])
    if (s.error) return setError(errorMessage(s.error))
    const balances = new Map((b.data ?? []).map((x) => [x.id, Number(x.balance)]))
    setSuppliers(s.data.map((x) => ({ ...x, balance: balances.get(x.id) ?? 0 })))
    setError(null)
  }, [restaurantId])

  useEffect(() => {
    void reload()
  }, [reload])

  return { suppliers, error, reload }
}
