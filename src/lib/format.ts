const money = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
})

/** $ 12.500 — sin decimales: en el salón nadie cobra centavos. */
export function formatMoney(value: number | null | undefined): string {
  return money.format(Math.round(value ?? 0))
}

/** Minutos transcurridos desde una fecha ISO. */
export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
}

/** "12 min", "1 h 05" */
export function formatElapsed(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h} h ${String(m).padStart(2, '0')}`
}

export const roleLabel: Record<string, string> = {
  owner: 'Dueño',
  manager: 'Encargado',
  cashier: 'Cajero',
  waiter: 'Mozo',
  kitchen: 'Cocina',
}
