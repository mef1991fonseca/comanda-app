import { useEffect, useState } from 'react'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Tables } from './database.types'

export type MpCharge = Tables<'mp_charges'>

/**
 * Cobro con QR de Mercado Pago. Todo pasa por la edge function `mercadopago`:
 * el Access Token nunca llega al dispositivo y el pago lo registra el servidor.
 */
async function call<T>(body: Record<string, unknown>): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('mercadopago', { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = (await error.context.json().catch(() => null)) as { error?: string } | null
      return { data: null, error: payload?.error ?? 'Mercado Pago no respondió.' }
    }
    return { data: null, error: 'No hay conexión con el servidor. Revisá internet y probá de nuevo.' }
  }
  return { data: data as T, error: null }
}

export const createQrCharge = (orderId: string, amount: number) =>
  call<{ charge: MpCharge }>({ action: 'create', order_id: orderId, amount })
export const refreshCharge = (chargeId: string) => call<{ charge: MpCharge }>({ action: 'refresh', charge_id: chargeId })
export const cancelCharge = (chargeId: string) => call<{ charge: MpCharge }>({ action: 'cancel', charge_id: chargeId })
export const mpStatus = () => call<{ connected: boolean; nickname: string | null; test: boolean }>({ action: 'status' })

/**
 * Sigue un cobro hasta que se paga, se cancela o vence: escucha en tiempo real
 * y, por si el aviso no llega, consulta cada 4 segundos.
 */
export function useCharge(initial: MpCharge) {
  const [charge, setCharge] = useState(initial)

  useEffect(() => {
    if (charge.status !== 'created') return
    let alive = true
    const channel = supabase
      .channel(`mp-charge-${charge.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'mp_charges', filter: `id=eq.${charge.id}` }, (p) => {
        if (alive) setCharge(p.new as MpCharge)
      })
      .subscribe()
    const timer = window.setInterval(async () => {
      const { data } = await refreshCharge(charge.id)
      if (alive && data?.charge) setCharge(data.charge)
    }, 4000)
    return () => {
      alive = false
      window.clearInterval(timer)
      void supabase.removeChannel(channel)
    }
  }, [charge.id, charge.status])

  return [charge, setCharge] as const
}
