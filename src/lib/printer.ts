/**
 * Impresora de este equipo (se guarda solo en este navegador).
 *
 * Imprime con la impresión del navegador en un marco oculto, sin salir de la pantalla. Si Chrome o Edge se
 * abren con `--kiosk-printing`, sale directo por la impresora predeterminada, sin diálogo: es la forma de
 * imprimir solo en una PC con Windows y la impresora USB instalada.
 *
 * Con `autoKitchen`, este equipo escucha en vivo los productos que se envían a cocina desde cualquier equipo
 * del local e imprime una comanda por pedido con lo nuevo. Recuerda lo que ya imprimió para no repetir.
 */
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export type PaperWidth = 80 | 58

export type PrinterSettings = {
  paper: PaperWidth
  /** Imprimir sola la comanda de cocina cada vez que se envían productos */
  autoKitchen: boolean
  /** Estaciones que imprime este equipo; vacío = todas */
  stations: string[]
}

const DEFAULTS: PrinterSettings = { paper: 80, autoKitchen: false, stations: [] }
const key = (restaurantId: string) => `comanda.printer.${restaurantId}`
const printedKey = (restaurantId: string) => `comanda.printed.${restaurantId}`
const EVENT = 'comanda-printer-settings'

export function getPrinterSettings(restaurantId: string): PrinterSettings {
  try {
    const raw = localStorage.getItem(key(restaurantId))
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PrinterSettings>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

export function savePrinterSettings(restaurantId: string, settings: PrinterSettings) {
  try {
    localStorage.setItem(key(restaurantId), JSON.stringify(settings))
  } catch {
    // sin almacenamiento: vale hasta recargar
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { restaurantId, settings } }))
}

export function usePrinterSettings(restaurantId: string) {
  const [settings, setSettings] = useState(() => getPrinterSettings(restaurantId))
  useEffect(() => {
    setSettings(getPrinterSettings(restaurantId))
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ restaurantId: string; settings: PrinterSettings }>).detail
      if (d.restaurantId === restaurantId) setSettings(d.settings)
    }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [restaurantId])
  const update = (patch: Partial<PrinterSettings>) => savePrinterSettings(restaurantId, { ...settings, ...patch })
  return { settings, update }
}

// ---------- Impresión en un marco oculto, de a una ----------
let queue: Promise<void> = Promise.resolve()

/** Abre `path` (una ruta /imprimir/...) en un iframe oculto; la página imprime sola y avisa al terminar. */
export function printInBackground(path: string): Promise<void> {
  const job = () =>
    new Promise<void>((resolve) => {
      const frame = document.createElement('iframe')
      frame.setAttribute('aria-hidden', 'true')
      frame.tabIndex = -1
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
      const done = () => {
        window.removeEventListener('message', onMessage)
        window.clearTimeout(timer)
        // Un respiro para que el navegador termine de mandar el trabajo a la impresora
        window.setTimeout(() => frame.remove(), 1000)
        resolve()
      }
      const onMessage = (e: MessageEvent) => {
        if (e.source === frame.contentWindow && (e.data as { type?: string } | null)?.type === 'comanda-printed') done()
      }
      const timer = window.setTimeout(done, 60_000)
      window.addEventListener('message', onMessage)
      frame.src = `${path}${path.includes('?') ? '&' : '?'}embed=1`
      document.body.appendChild(frame)
    })
  queue = queue.then(job, job)
  return queue
}

// ---------- Comandas que ya imprimió este equipo ----------
function readPrinted(restaurantId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(printedKey(restaurantId)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function writePrinted(restaurantId: string, ids: Set<string>) {
  try {
    // Alcanza con recordar los últimos 500 ítems
    localStorage.setItem(printedKey(restaurantId), JSON.stringify([...ids].slice(-500)))
  } catch {
    // sin almacenamiento
  }
}

type SentItem = { id: string; order_id: string; station_id: string | null; sent_at: string | null }

/** Ítems enviados recién que este equipo todavía no imprimió, agrupados por comanda. */
export function pendingKitchenPrints(items: SentItem[], printed: Set<string>, stations: string[]) {
  const byOrder = new Map<string, string[]>()
  for (const i of items) {
    if (printed.has(i.id)) continue
    if (stations.length > 0 && (!i.station_id || !stations.includes(i.station_id))) continue
    byOrder.set(i.order_id, [...(byOrder.get(i.order_id) ?? []), i.id])
  }
  return byOrder
}

/**
 * Montado en la app: si este equipo tiene activada la impresión automática, imprime cada pedido nuevo
 * que llega a cocina. Al activarla no imprime lo que ya estaba enviado; si el equipo estuvo apagado,
 * imprime lo enviado en los últimos 10 minutos que no haya impreso.
 */
export function useKitchenAutoPrint(restaurantId: string) {
  const { settings } = usePrinterSettings(restaurantId)
  const on = settings.autoKitchen
  const stationsKey = settings.stations.join(',')

  useEffect(() => {
    if (!on) return
    const stations = stationsKey ? stationsKey.split(',') : []
    let alive = true
    let running = false
    let again = false

    async function check() {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
        const { data } = await supabase
          .from('order_items')
          .select('id, order_id, station_id, sent_at')
          .eq('restaurant_id', restaurantId)
          .in('status', ['sent', 'preparing', 'ready', 'delivered'])
          .gte('sent_at', since)
          .order('sent_at')
        if (!alive || !data) return
        const printed = readPrinted(restaurantId)
        const jobs = pendingKitchenPrints(data, printed, stations)
        for (const [orderId, ids] of jobs) {
          ids.forEach((id) => printed.add(id))
          writePrinted(restaurantId, printed)
          void printInBackground(`/imprimir/cocina/${orderId}?items=${ids.join(',')}`)
        }
      } finally {
        running = false
        if (again && alive) {
          again = false
          void check()
        }
      }
    }

    void check()
    const channel = supabase
      .channel(`autoprint-${restaurantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `restaurant_id=eq.${restaurantId}` }, () => void check())
      .subscribe()
    // Por si se corta el tiempo real
    const timer = window.setInterval(() => void check(), 15_000)
    return () => {
      alive = false
      window.clearInterval(timer)
      void supabase.removeChannel(channel)
    }
  }, [restaurantId, on, stationsKey])
}

/** Al activar la impresión automática, lo que ya estaba en cocina se da por impreso. */
export async function markCurrentKitchenAsPrinted(restaurantId: string) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('order_items')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .in('status', ['sent', 'preparing', 'ready', 'delivered'])
    .gte('sent_at', since)
  const printed = readPrinted(restaurantId)
  for (const i of data ?? []) printed.add(i.id)
  writePrinted(restaurantId, printed)
}
