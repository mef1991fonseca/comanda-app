import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!url || !key) {
  throw new Error('Faltan VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY. Copiá .env.example a .env.')
}

export const supabase = createClient<Database>(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
})

/** Convierte un error de Supabase/Postgres en un mensaje para mostrar. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = String((error as { message: unknown }).message)
    if (msg.includes('Invalid login credentials')) return 'El email o la contraseña no coinciden.'
    if (msg.includes('Email not confirmed')) return 'Confirmá tu email con el enlace que te enviamos y volvé a entrar.'
    if (msg.includes('User already registered')) return 'Ya existe una cuenta con ese email. Iniciá sesión.'
    if (msg.includes('Password should be')) return 'La contraseña tiene que tener al menos 6 caracteres.'
    if (msg.includes('Failed to fetch')) return 'No hay conexión con el servidor. Revisá internet y probá de nuevo.'
    return msg
  }
  return 'Ocurrió un error inesperado.'
}
