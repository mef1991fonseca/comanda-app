import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import { cachedQuery } from './offline'
import type { Tables } from './database.types'

export type CashSession = Tables<'cash_sessions'>
export type CashMovement = Tables<'cash_movements'>
export type Payment = Tables<'payments'>
export type PaymentMethod = Tables<'payment_methods'>
export type Register = Tables<'registers'>

export type MethodSummary = { method: PaymentMethod; count: number; amount: number; tips: number }

export type CashSummary = {
  byMethod: MethodSummary[]
  cashSales: number
  cashTips: number
  movesIn: number
  movesOut: number
  /** Mismo cálculo que close_cash_session en la base */
  expectedCash: number
  totalSales: number
}

export function summarize(
  session: CashSession,
  payments: Payment[],
  methods: PaymentMethod[],
  moves: CashMovement[],
): CashSummary {
  const live = payments.filter((p) => !p.voided_at)
  const byMethod = methods
    .map((method) => {
      const list = live.filter((p) => p.payment_method_id === method.id)
      return {
        method,
        count: list.length,
        amount: list.reduce((s, p) => s + p.amount, 0),
        tips: list.reduce((s, p) => s + p.tip, 0),
      }
    })
    .filter((m) => m.count > 0)
  const cash = byMethod.filter((m) => m.method.kind === 'cash')
  const cashSales = cash.reduce((s, m) => s + m.amount, 0)
  const cashTips = cash.reduce((s, m) => s + m.tips, 0)
  const movesIn = moves.filter((m) => m.kind === 'in').reduce((s, m) => s + m.amount, 0)
  const movesOut = moves.filter((m) => m.kind === 'out').reduce((s, m) => s + m.amount, 0)
  return {
    byMethod,
    cashSales,
    cashTips,
    movesIn,
    movesOut,
    expectedCash: session.opening_amount + cashSales + cashTips + movesIn - movesOut,
    totalSales: byMethod.reduce((s, m) => s + m.amount, 0),
  }
}

// ---------- Caja de este equipo ----------
// Cada dispositivo trabaja con una caja (la elige quien cobra). Se guarda solo en este navegador.
const deviceKey = (restaurantId: string) => `comanda.register.${restaurantId}`

export function getDeviceRegister(restaurantId: string): string | null {
  try {
    return localStorage.getItem(deviceKey(restaurantId))
  } catch {
    return null
  }
}

export function setDeviceRegister(restaurantId: string, registerId: string) {
  try {
    localStorage.setItem(deviceKey(restaurantId), registerId)
  } catch {
    // sin almacenamiento: se elige de nuevo la próxima vez
  }
}

/**
 * Cajas abiertas del local. Con red consulta y guarda; sin red devuelve lo último guardado
 * (para poder cobrar en efectivo sin conexión con la caja que estaba abierta).
 */
export async function openCashSessions(restaurantId: string): Promise<{ id: string; register_id: string }[]> {
  const res = await cachedQuery<{ id: string; register_id: string }>(
    `cash:open:${restaurantId}`,
    'cash_sessions',
    [],
    () => supabase.from('cash_sessions').select('id, register_id').eq('restaurant_id', restaurantId).is('closed_at', null),
  )
  return res.data
}

/**
 * Sesión abierta de la caja de este equipo, para mandarla con los cobros.
 * Si este equipo no eligió caja o la suya está cerrada, devuelve undefined y el servidor decide
 * (la caja que abrió esa persona, o la única abierta).
 */
export async function deviceSessionId(restaurantId: string): Promise<string | undefined> {
  const registerId = getDeviceRegister(restaurantId)
  if (!registerId) return undefined
  const open = await openCashSessions(restaurantId)
  return open.find((s) => s.register_id === registerId)?.id
}

/** El cajero no ve lo esperado en una caja con arqueo ciego (dueño y encargado sí). */
export const isBlindFor = (register: Register | null | undefined, role: string) =>
  Boolean(register?.blind_close) && role !== 'owner' && role !== 'manager'

/**
 * Cajas del local con su estado, y el detalle de la caja elegida en este equipo:
 * sesión abierta (si hay), sus pagos y movimientos, y sus últimos cierres.
 */
export function useCash(restaurantId: string) {
  const [registers, setRegisters] = useState<Register[]>([])
  const [openSessions, setOpenSessions] = useState<CashSession[]>([])
  const [registerId, setRegisterIdState] = useState<string | null>(() => getDeviceRegister(restaurantId))
  const [payments, setPayments] = useState<Payment[]>([])
  const [moves, setMoves] = useState<CashMovement[]>([])
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [history, setHistory] = useState<CashSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const active = registers.filter((r) => r.active)
  const register = active.find((r) => r.id === registerId) ?? active[0] ?? null
  const session = register ? openSessions.find((s) => s.register_id === register.id) ?? null : null

  const reload = useCallback(async () => {
    const [r, m, open] = await Promise.all([
      supabase.from('registers').select('*').eq('restaurant_id', restaurantId).order('created_at'),
      supabase.from('payment_methods').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
      supabase.from('cash_sessions').select('*').eq('restaurant_id', restaurantId).is('closed_at', null).order('opened_at'),
    ])
    const failed = [r, m, open].find((x) => x.error)
    if (failed?.error) {
      setError(errorMessage(failed.error))
      setLoading(false)
      return
    }
    setRegisters(r.data ?? [])
    setMethods(m.data ?? [])
    setOpenSessions(open.data ?? [])
    setError(null)
    setLoading(false)
  }, [restaurantId])

  // Detalle de la caja elegida
  const registerKey = register?.id ?? null
  const sessionKey = session?.id ?? null
  const reloadDetail = useCallback(async () => {
    if (!registerKey) return
    const closed = await supabase
      .from('cash_sessions')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('register_id', registerKey)
      .not('closed_at', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(10)
    setHistory(closed.data ?? [])
    if (sessionKey) {
      const [p, mv] = await Promise.all([
        supabase.from('payments').select('*').eq('cash_session_id', sessionKey),
        supabase.from('cash_movements').select('*').eq('cash_session_id', sessionKey).order('created_at'),
      ])
      setPayments(p.data ?? [])
      setMoves(mv.data ?? [])
    } else {
      setPayments([])
      setMoves([])
    }
  }, [restaurantId, registerKey, sessionKey])

  useEffect(() => {
    void reloadDetail()
  }, [reloadDetail])

  const reloadAll = useCallback(async () => {
    await reload()
    await reloadDetail()
  }, [reload, reloadDetail])

  useEffect(() => {
    void reload()
    const channel = supabase
      .channel(`caja-${restaurantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments', filter: `restaurant_id=eq.${restaurantId}` }, () => void reloadAll())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [restaurantId, reload, reloadAll])

  const chooseRegister = useCallback(
    (id: string) => {
      setDeviceRegister(restaurantId, id)
      setRegisterIdState(id)
    },
    [restaurantId],
  )

  return {
    registers,
    openSessions,
    register,
    session,
    chooseRegister,
    payments,
    moves,
    methods,
    history,
    loading,
    error,
    reload: reloadAll,
  }
}

/** Convierte lo que escribe la persona ("12.500", "12500,50") en número. */
export function parseAmount(text: string): number {
  const n = Number(text.replace(/\$/g, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
