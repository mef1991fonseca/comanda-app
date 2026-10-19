import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import type { Enums, Tables } from './database.types'

export type Ingredient = Tables<'ingredients'>
export type StockMovement = Tables<'stock_movements'>
export type RecipeItem = Tables<'recipe_items'>
export type StockUnit = Enums<'stock_unit'>
export type StockReason = Enums<'stock_reason'>

export const unitOptions: { value: StockUnit; label: string; short: string }[] = [
  { value: 'unit', label: 'Unidades', short: 'u' },
  { value: 'g', label: 'Gramos', short: 'g' },
  { value: 'kg', label: 'Kilos', short: 'kg' },
  { value: 'ml', label: 'Mililitros', short: 'ml' },
  { value: 'l', label: 'Litros', short: 'l' },
]

export const unitShort = (u: StockUnit) => unitOptions.find((o) => o.value === u)?.short ?? u

export const reasonLabel: Record<StockReason, string> = {
  sale: 'Venta',
  sale_reversal: 'Venta reabierta',
  purchase: 'Compra',
  adjustment: 'Ajuste',
  waste: 'Merma',
  count: 'Conteo',
}

const qtyFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 })

/** "1.250 g", "3 u" */
export function formatQty(qty: number, unit: StockUnit): string {
  return `${qtyFmt.format(qty)} ${unitShort(unit)}`
}

export const isLow = (i: Ingredient) => i.min_stock > 0 && i.stock_qty <= i.min_stock

/** Costo de una unidad de producto según su receta. null si no tiene receta. */
export function recipeCost(lines: { ingredient_id: string; quantity: number }[], ingredients: Ingredient[]): number | null {
  if (lines.length === 0) return null
  return lines.reduce((s, l) => s + l.quantity * (ingredients.find((i) => i.id === l.ingredient_id)?.cost_per_unit ?? 0), 0)
}

export function useIngredients(restaurantId: string) {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('ingredients')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('name')
    if (error) setError(errorMessage(error))
    else {
      setIngredients(data)
      setError(null)
    }
    setLoading(false)
  }, [restaurantId])

  useEffect(() => {
    void reload()
  }, [reload])

  return { ingredients, loading, error, reload }
}
