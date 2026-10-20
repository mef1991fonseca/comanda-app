import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { cachedQuery } from './offline'
import type { Enums } from './database.types'

export type TeamMember = { user_id: string; role: Enums<'member_role'>; name: string }

/** "Lucía Pérez" → "Lucía P." para que entre en la mesa del salón. */
export const shortName = (name: string) => {
  const [first, last] = name.trim().split(/\s+/)
  return last ? `${first} ${last[0]}.` : (first ?? '')
}

/** Personas activas del local con su nombre (guardado en el dispositivo para usar sin conexión). */
export function useTeam(restaurantId: string) {
  const [team, setTeam] = useState<TeamMember[]>([])

  useEffect(() => {
    let alive = true
    async function load() {
      const m = await cachedQuery<{ user_id: string; role: Enums<'member_role'>; display_name: string | null }>(
        `team:${restaurantId}:members`,
        'restaurant_members',
        [],
        () => supabase.from('restaurant_members').select('user_id, role, display_name').eq('restaurant_id', restaurantId).eq('active', true),
      )
      const ids = m.data.map((x) => x.user_id)
      const p = ids.length
        ? await cachedQuery<{ id: string; full_name: string | null }>(`team:${restaurantId}:profiles`, 'profiles', [], () =>
            supabase.from('profiles').select('id, full_name').in('id', ids),
          )
        : { data: [] }
      const names = new Map(p.data.map((x) => [x.id, x.full_name]))
      if (alive)
        setTeam(
          m.data
            .map((x) => ({ user_id: x.user_id, role: x.role, name: x.display_name ?? names.get(x.user_id) ?? 'Sin nombre' }))
            .sort((a, b) => a.name.localeCompare(b.name, 'es')),
        )
    }
    void load()
    return () => {
      alive = false
    }
  }, [restaurantId])

  return team
}
