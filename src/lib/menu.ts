import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import { cachedQuery } from './offline'
import type { Tables } from './database.types'

export type Category = Tables<'categories'>
export type Product = Tables<'products'>
export type Station = Tables<'stations'>
export type Modifier = Tables<'modifiers'>
export type ModifierGroup = Tables<'modifier_groups'> & { modifiers: Modifier[] }
export type ProductWithGroups = Product & { groups: ModifierGroup[] }

export type Menu = {
  categories: Category[]
  products: ProductWithGroups[]
  groups: ModifierGroup[]
  stations: Station[]
}

const empty: Menu = { categories: [], products: [], groups: [], stations: [] }

/** Carta completa de un local. `includeInactive` para la pantalla de administración. */
export function useMenu(restaurantId: string, includeInactive = false) {
  const [menu, setMenu] = useState<Menu>(empty)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    // La carta se guarda en el dispositivo para tomar pedidos sin conexión
    const k = (name: string) => `menu:${restaurantId}:${name}`
    const [c, p, g, m, pmg, s] = await Promise.all([
      cachedQuery(k('categories'), 'categories', [], () =>
        supabase.from('categories').select('*').eq('restaurant_id', restaurantId).order('sort_order').order('name'),
      ),
      cachedQuery(k('products'), 'products', [], () =>
        supabase.from('products').select('*').eq('restaurant_id', restaurantId).order('sort_order').order('name'),
      ),
      cachedQuery(k('groups'), 'modifier_groups', [], () =>
        supabase.from('modifier_groups').select('*').eq('restaurant_id', restaurantId).order('name'),
      ),
      cachedQuery(k('modifiers'), 'modifiers', [], () =>
        supabase.from('modifiers').select('*').eq('restaurant_id', restaurantId).order('sort_order').order('name'),
      ),
      cachedQuery(k('links'), 'product_modifier_groups', [], () =>
        supabase.from('product_modifier_groups').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
      ),
      cachedQuery(k('stations'), 'stations', [], () =>
        supabase.from('stations').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
      ),
    ])
    const failed = [c, p, g, m, pmg, s].find((r) => r.error)
    if (failed?.error) {
      setError(errorMessage(failed.error))
      setLoading(false)
      return
    }
    const modifiers = (m.data ?? []).filter((x) => includeInactive || x.active)
    const groups: ModifierGroup[] = (g.data ?? []).map((grp) => ({
      ...grp,
      modifiers: modifiers.filter((x) => x.group_id === grp.id),
    }))
    const groupById = new Map(groups.map((x) => [x.id, x]))
    const products: ProductWithGroups[] = (p.data ?? [])
      .filter((x) => includeInactive || x.active)
      .map((prod) => ({
        ...prod,
        groups: (pmg.data ?? [])
          .filter((l) => l.product_id === prod.id)
          .map((l) => groupById.get(l.group_id))
          .filter((x): x is ModifierGroup => x !== undefined),
      }))
    setMenu({
      categories: (c.data ?? []).filter((x) => includeInactive || x.active),
      products,
      groups,
      stations: (s.data ?? []).filter((x) => x.active),
    })
    setError(null)
    setLoading(false)
  }, [restaurantId, includeInactive])

  useEffect(() => {
    void reload()
  }, [reload])

  return { menu, loading, error, reload }
}

/** Productos agrupados por categoría, en el orden de la carta. Los sin categoría van al final. */
export function useProductsByCategory(menu: Menu) {
  return useMemo(() => {
    const sections = menu.categories.map((cat) => ({
      category: cat as Category | null,
      products: menu.products.filter((p) => p.category_id === cat.id),
    }))
    const loose = menu.products.filter((p) => !p.category_id || !menu.categories.some((c) => c.id === p.category_id))
    if (loose.length) sections.push({ category: null, products: loose })
    return sections
  }, [menu])
}

/** Valida una selección de modificadores contra los mínimos y máximos de cada grupo. */
export function validateSelection(groups: ModifierGroup[], selected: Set<string>): string | null {
  for (const g of groups) {
    const count = g.modifiers.filter((m) => selected.has(m.id)).length
    const min = Math.min(g.min_select, g.modifiers.length) // igual que el servidor: un grupo sin opciones activas no bloquea
    if (count < min) {
      return min === 1 ? `Elegí una opción de ${g.name}.` : `Elegí al menos ${min} en ${g.name}.`
    }
    if (count > g.max_select) return `En ${g.name} se pueden elegir hasta ${g.max_select}.`
  }
  return null
}
