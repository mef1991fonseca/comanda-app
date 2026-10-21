/**
 * Modo sin conexión.
 *
 * Alcance: comandas, ítems, cocina y cobros en efectivo, tarjeta o transferencia (con su cierre).
 *
 * Lecturas: cada consulta guarda su resultado en IndexedDB. Sin red se devuelve la última copia,
 * con los cambios pendientes superpuestos para que la pantalla muestre lo que el usuario hizo.
 *
 * Escrituras: pasan por una cola (outbox) persistente. Con red y cola vacía se envían directo;
 * si no hay red (o la cola tiene cosas) se encolan y se mandan en orden al volver. Los IDs se
 * generan en el dispositivo, así un reintento no duplica (un 23505 se toma como ya guardado).
 * Si la base rechaza un cambio por una regla de negocio, pasa a "fallidos" para mostrarlo.
 */
import { createStore, del, get, keys, set } from 'idb-keyval'
import { supabase } from './supabase'

type Row = Record<string, unknown>
type Match = Record<string, unknown>

export type Filter =
  | { col: string; op: 'eq'; value: unknown }
  | { col: string; op: 'in'; value: unknown[] }
  | { col: string; op: 'notNull' }
  | { col: string; op: 'isNull' }
  | { col: string; op: 'gte'; value: string }

/** Variación de una comanda mientras el cambio está pendiente: subtotal (ítems) o lo cobrado (pagos). */
export type Delta = { order_id: string; amount?: number; paid?: number }

export type Op = {
  id: string
  at: number
  table: string
  kind: 'insert' | 'update' | 'delete'
  /** fila a insertar (insert) */
  row?: Row
  /** cambios a aplicar (update) */
  patch?: Row
  /** condición (update/delete): valor = igualdad, arreglo = "in" */
  match?: Match
  /** campos que solo se usan para mostrar mientras está pendiente (p. ej. line_total) */
  view?: Row
  /** variación de subtotal o de lo cobrado que provoca este cambio (para mostrar totales sin red) */
  deltas?: Delta[]
  /** texto para la persona: "Agregar Milanesa a Mesa 3" */
  label: string
}

export type FailedOp = Op & { error: string }

const store = createStore('comanda', 'kv')
const OUTBOX = 'outbox'
const FAILED = 'outbox-failed'
const CACHE_PREFIX = 'cache:'

let outbox: Op[] = []
let failed: FailedOp[] = []
let flushing: Promise<void> | null = null
const ready: Promise<void> = (async () => {
  try {
    outbox = ((await get(OUTBOX, store)) as Op[] | undefined) ?? []
    failed = ((await get(FAILED, store)) as FailedOp[] | undefined) ?? []
  } catch {
    outbox = []
    failed = []
  }
})()

// ---------------------------------------------------------------------------
// Estado observable (para la barra de sincronización y para recargar pantallas)
// ---------------------------------------------------------------------------
export type SyncState = { online: boolean; pending: number; failed: FailedOp[]; syncing: boolean }

const listeners = new Set<(s: SyncState) => void>()
const syncedListeners = new Set<() => void>()
let syncing = false

export function syncState(): SyncState {
  return { online: navigator.onLine, pending: outbox.length, failed, syncing }
}

function emit() {
  const s = syncState()
  for (const l of listeners) l(s)
}

export function onSyncState(l: (s: SyncState) => void): () => void {
  listeners.add(l)
  void ready.then(() => l(syncState()))
  return () => listeners.delete(l)
}

/** Se llama después de una sincronización que aplicó cambios: las pantallas recargan. */
export function onSynced(l: () => void): () => void {
  syncedListeners.add(l)
  return () => syncedListeners.delete(l)
}

async function persist() {
  try {
    await set(OUTBOX, outbox, store)
    await set(FAILED, failed, store)
  } catch {
    /* sin almacenamiento: la cola vive solo en memoria */
  }
  emit()
}

// ---------------------------------------------------------------------------
// Detección de errores de red
// ---------------------------------------------------------------------------
export function isNetworkError(error: unknown): boolean {
  if (!navigator.onLine) return true
  const msg = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? '')
  return /Failed to fetch|NetworkError|Load failed|fetch failed|Network request failed/i.test(msg)
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------
function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col]
    switch (f.op) {
      case 'eq':
        return v === f.value
      case 'in':
        return f.value.includes(v)
      case 'notNull':
        return v !== null && v !== undefined
      case 'isNull':
        return v === null || v === undefined
      case 'gte':
        return typeof v === 'string' && v >= f.value
    }
  })
}

function matchesMatch(row: Row, match: Match): boolean {
  return Object.entries(match).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v))
}

/** Aplica los cambios pendientes de la cola sobre filas leídas (del servidor o de la caché). */
export function overlay<T extends Row>(table: string, filters: Filter[], rows: T[]): T[] {
  let out: Row[] = rows.map((r) => ({ ...r }))
  for (const op of outbox) {
    if (op.table === table) {
      if (op.kind === 'insert' && op.row) {
        const row = { ...op.row, ...op.view }
        if (!out.some((r) => r.id === row.id)) out.push(row)
      } else if (op.kind === 'update' && op.match) {
        out = out.map((r) => (matchesMatch(r, op.match as Match) ? { ...r, ...op.patch, ...op.view } : r))
      } else if (op.kind === 'delete' && op.match) {
        out = out.filter((r) => !matchesMatch(r, op.match as Match))
      }
    }
    if (table === 'orders' && op.deltas) {
      for (const d of op.deltas) {
        out = out.map((r) => {
          if (r.id !== d.order_id) return r
          const subtotal = Number(r.subtotal ?? 0) + (d.amount ?? 0)
          return {
            ...r,
            subtotal,
            total: Math.max(subtotal - Number(r.discount_amount ?? 0), 0),
            paid_total: Number(r.paid_total ?? 0) + (d.paid ?? 0),
          }
        })
      }
    }
  }
  return out.filter((r) => matchesFilters(r, filters)) as T[]
}

export type CachedResult<T> = { data: T[]; error: unknown; fromCache: boolean }

/**
 * Ejecuta una consulta y guarda el resultado; si no hay red, devuelve la última copia.
 * `filters` describe la misma condición de la consulta (para superponer los cambios pendientes).
 */
/** Lo que haya guardado otra consulta en el dispositivo (sin ir a la red). */
export async function readCached<T>(key: string): Promise<T[]> {
  try {
    return ((await get(CACHE_PREFIX + key, store)) as T[] | undefined) ?? []
  } catch {
    return []
  }
}

export async function cachedQuery<T extends Row>(
  key: string,
  table: string,
  filters: Filter[],
  run: () => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<CachedResult<T>> {
  await ready
  if (navigator.onLine) {
    const res = await run()
    if (!res.error) {
      const data = res.data ?? []
      try {
        await set(CACHE_PREFIX + key, data, store)
      } catch {
        /* sin almacenamiento */
      }
      return { data: overlay(table, filters, data), error: null, fromCache: false }
    }
    if (!isNetworkError(res.error)) return { data: [], error: res.error, fromCache: false }
  }
  let cached: T[] | undefined
  try {
    cached = (await get(CACHE_PREFIX + key, store)) as T[] | undefined
  } catch {
    cached = undefined
  }
  if (!cached) {
    const local = overlay(table, filters, [] as T[])
    return {
      data: local,
      error: local.length ? null : { message: 'Sin conexión y sin datos guardados en este dispositivo.' },
      fromCache: true,
    }
  }
  return { data: overlay(table, filters, cached), error: null, fromCache: true }
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------
async function execute(op: Op): Promise<{ error: unknown }> {
  const q = supabase.from(op.table as never) as unknown as {
    insert: (r: Row) => PromiseLike<{ error: unknown }>
    update: (p: Row) => FilterBuilder
    delete: () => FilterBuilder
  }
  type FilterBuilder = PromiseLike<{ error: unknown }> & {
    eq: (c: string, v: unknown) => FilterBuilder
    in: (c: string, v: unknown[]) => FilterBuilder
  }
  const applyMatch = (b: FilterBuilder) => {
    let builder = b
    for (const [k, v] of Object.entries(op.match ?? {})) builder = Array.isArray(v) ? builder.in(k, v) : builder.eq(k, v)
    return builder
  }
  if (op.kind === 'insert') {
    const { error } = await q.insert(op.row ?? {})
    // Ya estaba guardado (reintento después de una respuesta perdida)
    if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23505') return { error: null }
    return { error }
  }
  if (op.kind === 'update') return applyMatch(q.update(op.patch ?? {}))
  return applyMatch(q.delete())
}

export type WriteResult = { error: unknown; queued: boolean }

/**
 * Guarda un cambio. Con red y sin cola pendiente se manda directo.
 * Si no hay red o falla la red, queda en la cola y se envía después.
 */
export async function write(input: Omit<Op, 'id' | 'at'>): Promise<WriteResult> {
  await ready
  const op: Op = { ...input, id: crypto.randomUUID(), at: Date.now() }
  if (navigator.onLine && outbox.length === 0) {
    const { error } = await execute(op)
    if (!error) return { error: null, queued: false }
    if (!isNetworkError(error)) return { error, queued: false }
  }
  outbox.push(op)
  await persist()
  void flush()
  return { error: null, queued: true }
}

function emitSynced() {
  for (const l of syncedListeners) l()
}

/** Envía la cola en orden. Se detiene ante un error de red; los rechazos de negocio pasan a fallidos. */
export function flush(): Promise<void> {
  if (flushing) return flushing
  flushing = (async () => {
    await ready
    if (!navigator.onLine || outbox.length === 0) return
    syncing = true
    emit()
    let applied = 0
    while (outbox.length) {
      const op = outbox[0] as Op
      const { error } = await execute(op)
      if (error && isNetworkError(error)) break
      outbox.shift()
      if (error) {
        const msg = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : 'Error desconocido'
        failed.push({ ...op, error: msg })
      } else {
        applied++
      }
      await persist()
    }
    syncing = false
    emit()
    if (applied) emitSynced()
  })().finally(() => {
    flushing = null
  })
  return flushing
}

export async function discardFailed(id?: string) {
  await ready
  failed = id ? failed.filter((f) => f.id !== id) : []
  await persist()
}

/** Borra las copias locales (al cerrar sesión). La cola pendiente se conserva. */
export async function clearCache() {
  try {
    const all = await keys(store)
    await Promise.all(all.filter((k) => String(k).startsWith(CACHE_PREFIX)).map((k) => del(k, store)))
  } catch {
    /* sin almacenamiento */
  }
}

export function pendingCount() {
  return outbox.length
}

// Reintentos: al volver la conexión y cada 20 s mientras haya algo pendiente
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    emit()
    void flush()
  })
  window.addEventListener('offline', emit)
  setInterval(() => {
    if (outbox.length && navigator.onLine) void flush()
  }, 20_000)
}
