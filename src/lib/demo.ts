import { supabase, errorMessage } from './supabase'

/** Días de historial que se cargan (uno por llamada, para no pasar el límite de tiempo del servidor). */
export const DEMO_DAYS = 24

export type DemoProgress = { step: number; total: number; label: string }

/**
 * Arma el local de demostración: carta, stock, clientes y gastos; ventas de los últimos días;
 * y el "ahora" (caja abierta, mesas ocupadas). Avisa el avance para mostrar la barra.
 */
export async function buildDemo(onProgress: (p: DemoProgress) => void): Promise<{ id: string | null; error: string | null }> {
  const total = DEMO_DAYS + 2
  onProgress({ step: 0, total, label: 'Armando la carta, el stock y los proveedores…' })
  const created = await supabase.rpc('create_demo_restaurant')
  if (created.error || !created.data) return { id: null, error: errorMessage(created.error) }
  const id = created.data
  for (let d = DEMO_DAYS; d >= 1; d--) {
    onProgress({ step: DEMO_DAYS - d + 1, total, label: `Cargando las ventas de hace ${d} día${d === 1 ? '' : 's'}…` })
    const { error } = await supabase.rpc('demo_fill_day', { p_restaurant: id, p_days_ago: d })
    if (error) return { id, error: errorMessage(error) }
  }
  onProgress({ step: total - 1, total, label: 'Abriendo la caja y ocupando mesas…' })
  const fin = await supabase.rpc('demo_finish', { p_restaurant: id })
  if (fin.error) return { id, error: errorMessage(fin.error) }
  // En la demo la carta QR ya toma pedidos, para poder mostrarlo
  await supabase.rpc('set_menu_ordering', { p_restaurant: id, p_enabled: true })
  onProgress({ step: total, total, label: 'Listo' })
  return { id, error: null }
}

export async function deleteDemo(restaurantId: string) {
  const { error } = await supabase.rpc('delete_demo_restaurant', { p_restaurant: restaurantId })
  return error ? errorMessage(error) : null
}
