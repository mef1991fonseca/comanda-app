import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase, errorMessage } from './supabase'
import { cachedQuery } from './offline'
import { useAuth } from './auth'
import type { Enums, Tables } from './database.types'

export type Membership = {
  role: Enums<'member_role'>
  restaurant: Tables<'restaurants'>
}

type RestaurantState = {
  loading: boolean
  error: string | null
  memberships: Membership[]
  current: Membership | null
  select: (restaurantId: string) => void
  reload: () => Promise<void>
}

const STORAGE_KEY = 'comanda.currentRestaurant'

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* almacenamiento no disponible: se elige el primero la próxima vez */
  }
}

const RestaurantContext = createContext<RestaurantState | null>(null)

export function RestaurantProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const userId = session?.user.id
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [currentId, setCurrentId] = useState<string | null>(readStored)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!userId) {
      setMemberships([])
      setLoading(false)
      return
    }
    setLoading(true)
    // Se guarda en el dispositivo para poder abrir la app sin conexión
    const { data, error } = await cachedQuery(`members:${userId}`, 'restaurant_members', [], () =>
      supabase
        .from('restaurant_members')
        .select('role, restaurant:restaurants(*)')
        .eq('user_id', userId)
        .eq('active', true),
    )
    if (error) {
      setError(errorMessage(error))
    } else {
      setError(null)
      const list = (data ?? [])
        .filter((m): m is Membership => m.restaurant !== null)
        .sort((a, b) => a.restaurant.name.localeCompare(b.restaurant.name, 'es'))
      setMemberships(list)
    }
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void reload()
  }, [reload])

  const select = useCallback((id: string) => {
    setCurrentId(id)
    writeStored(id)
  }, [])

  const current =
    memberships.find((m) => m.restaurant.id === currentId) ?? memberships[0] ?? null

  return (
    <RestaurantContext.Provider value={{ loading, error, memberships, current, select, reload }}>
      {children}
    </RestaurantContext.Provider>
  )
}

export function useRestaurant() {
  const ctx = useContext(RestaurantContext)
  if (!ctx) throw new Error('useRestaurant fuera de RestaurantProvider')
  return ctx
}

/** El local actual; solo usar dentro de rutas que ya garantizan que existe. */
export function useCurrentRestaurant(): Membership {
  const { current } = useRestaurant()
  if (!current) throw new Error('No hay local seleccionado')
  return current
}
