import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
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

/** Caja principal del local: sesión abierta (si hay), sus pagos y movimientos, y los últimos cierres. */
export function useCash(restaurantId: string) {
  const [register, setRegister] = useState<Register | null>(null)
  const [session, setSession] = useState<CashSession | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [moves, setMoves] = useState<CashMovement[]>([])
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [history, setHistory] = useState<CashSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [r, m, open, closed] = await Promise.all([
      supabase.from('registers').select('*').eq('restaurant_id', restaurantId).eq('active', true).order('created_at').limit(1).maybeSingle(),
      supabase.from('payment_methods').select('*').eq('restaurant_id', restaurantId).order('sort_order'),
      supabase.from('cash_sessions').select('*').eq('restaurant_id', restaurantId).is('closed_at', null).order('opened_at').limit(1).maybeSingle(),
      supabase.from('cash_sessions').select('*').eq('restaurant_id', restaurantId).not('closed_at', 'is', null).order('closed_at', { ascending: false }).limit(10),
    ])
    const failed = [r, m, open, closed].find((x) => x.error)
    if (failed?.error) {
      setError(errorMessage(failed.error))
      setLoading(false)
      return
    }
    setRegister(r.data)
    setMethods(m.data ?? [])
    setSession(open.data)
    setHistory(closed.data ?? [])
    if (open.data) {
      const [p, mv] = await Promise.all([
        supabase.from('payments').select('*').eq('cash_session_id', open.data.id),
        supabase.from('cash_movements').select('*').eq('cash_session_id', open.data.id).order('created_at'),
      ])
      setPayments(p.data ?? [])
      setMoves(mv.data ?? [])
    } else {
      setPayments([])
      setMoves([])
    }
    setError(null)
    setLoading(false)
  }, [restaurantId])

  useEffect(() => {
    void reload()
    const channel = supabase
      .channel(`caja-${restaurantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments', filter: `restaurant_id=eq.${restaurantId}` }, () => void reload())
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [restaurantId, reload])

  return { register, session, payments, moves, methods, history, loading, error, reload }
}

/** Convierte lo que escribe la persona ("12.500", "12500,50") en número. */
export function parseAmount(text: string): number {
  const n = Number(text.replace(/\$/g, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
