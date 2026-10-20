import type { Enums } from './database.types'

/**
 * Invitaciones al equipo: el dueño comparte un link /invitacion/<token>.
 * El token se guarda en el dispositivo hasta que la persona inicia sesión (o crea su cuenta
 * y confirma el email) y acepta.
 */
const KEY = 'comanda.pendingInvite'
const PATH = /^\/invitacion\/([A-Za-z0-9_-]{8,})\/?$/

/** Si la app se abrió desde un link de invitación, guarda el token y limpia la URL. */
export function captureInviteFromUrl() {
  const match = PATH.exec(window.location.pathname)
  if (!match?.[1]) return
  try {
    localStorage.setItem(KEY, match[1])
  } catch {
    /* sin almacenamiento: se pierde la invitación al recargar, el link sigue sirviendo */
  }
  // Se conserva el hash/query: si viene del email de confirmación trae la sesión
  window.history.replaceState(null, '', '/' + window.location.search + window.location.hash)
  memory = match[1]
}

let memory: string | null = null

export function pendingInvite(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory
  } catch {
    return memory
  }
}

export function clearPendingInvite() {
  memory = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nada que limpiar */
  }
}

export function inviteUrl(token: string) {
  return `${window.location.origin}/invitacion/${token}`
}

/** Qué puede hacer cada rol, para elegir al invitar. */
export const roleHelp: Record<Enums<'member_role'>, string> = {
  owner: 'Acceso total, incluido el equipo y los dueños',
  manager: 'Carta, stock, reportes, caja y equipo',
  cashier: 'Cobra, maneja la caja y aplica descuentos',
  waiter: 'Abre mesas, toma pedidos y los envía a cocina',
  kitchen: 'Ve la pantalla de cocina y marca platos listos',
}

export type InvitePreview = {
  status: 'ok' | 'member' | 'used' | 'expired' | 'revoked' | 'invalid'
  restaurant_id?: string
  restaurant_name?: string
  role?: Enums<'member_role'>
  invited_by?: string | null
  expires_at?: string
}
