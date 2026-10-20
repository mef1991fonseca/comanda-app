import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { clearCache } from '../lib/offline'
import { useSync } from '../lib/useSync'
import { mpStatus } from '../lib/mercadopago'
import { useAuth } from '../lib/auth'
import { useCurrentRestaurant, useRestaurant } from '../lib/restaurant'
import { roleLabel } from '../lib/format'
import type { Enums } from '../lib/database.types'
import { TopBar } from '../components/AppShell'

type Member = { user_id: string; role: Enums<'member_role'>; display_name: string | null; name: string | null }

export function Mas() {
  const { session } = useAuth()
  const { restaurant, role } = useCurrentRestaurant()
  const { memberships, select } = useRestaurant()
  const navigate = useNavigate()
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('restaurant_members')
        .select('user_id, role, display_name')
        .eq('restaurant_id', restaurant.id)
        .eq('active', true)
      if (error) return setError(errorMessage(error))
      const ids = data.map((m) => m.user_id)
      const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', ids)
      const names = new Map((profiles ?? []).map((p) => [p.id, p.full_name]))
      setMembers(data.map((m) => ({ ...m, name: names.get(m.user_id) ?? null })))
    }
    void load()
  }, [restaurant.id])

  const { pending } = useSync()
  const isAdmin = role === 'owner' || role === 'manager'
  const [mp, setMp] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin || !navigator.onLine) return
    void mpStatus().then(({ data, error }) =>
      setMp(error ?? (data?.connected ? `Conectado${data.test ? ' · cuenta de prueba' : ''}` : 'Sin conectar')),
    )
  }, [isAdmin])

  async function signOut() {
    if (
      pending > 0 &&
      !window.confirm(`Hay ${pending} cambios sin sincronizar en este dispositivo. Si cerrás sesión se envían cuando vuelvas a entrar. ¿Cerrar sesión igual?`)
    )
      return
    await clearCache()
    await supabase.auth.signOut()
  }

  return (
    <>
      <TopBar title="Más" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {(role === 'owner' || role === 'manager') && (
          <section className="section">
            <h2>Local</h2>
            <div className="list">
              <button className="list-row" onClick={() => navigate('/equipo')}>
                <span>Equipo</span>
                <span className="muted">Invitar personas y cambiar roles</span>
              </button>
              <button className="list-row" onClick={() => navigate('/carta')}>
                <span>Carta</span>
                <span className="muted">Productos, recetas y modificadores</span>
              </button>
              <button className="list-row" onClick={() => navigate('/stock')}>
                <span>Stock</span>
                <span className="muted">Insumos, compras, mermas y conteos</span>
              </button>
              <button className="list-row" onClick={() => navigate('/reportes')}>
                <span>Reportes</span>
                <span className="muted">Ventas, medios de pago y productos</span>
              </button>
              <button className="list-row" onClick={() => navigate('/cocina')}>
                <span>Pantalla de cocina</span>
                <span className="muted">Pedidos en preparación</span>
              </button>
            </div>
          </section>
        )}

        {isAdmin && (
          <section className="section">
            <h2>Cobros</h2>
            <div className="list">
              <div className="list-row">
                <span className="product-line">
                  <span>Mercado Pago (QR)</span>
                  <span className="product-sub">{mp ?? 'Revisando…'}</span>
                </span>
                {mp?.startsWith('Conectado') && <span className="badge">Activo</span>}
              </div>
            </div>
          </section>
        )}

        <section className="section">
          <h2>Equipo</h2>
          <div className="list">
            {members.map((m) => (
              <div key={m.user_id} className="list-row">
                <span>
                  {m.display_name ?? m.name ?? 'Sin nombre'}
                  {m.user_id === session?.user.id && <span className="muted"> (vos)</span>}
                </span>
                <span className="badge">{roleLabel[m.role]}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="section">
          <h2>Locales</h2>
          <div className="list">
            {memberships.map((m) => (
              <button
                key={m.restaurant.id}
                className="list-row"
                onClick={() => {
                  select(m.restaurant.id)
                  navigate('/', { replace: true })
                }}
                aria-current={m.restaurant.id === restaurant.id}
              >
                <span>{m.restaurant.name}</span>
                {m.restaurant.id === restaurant.id ? (
                  <span className="badge">Actual</span>
                ) : (
                  <span className="muted">{roleLabel[m.role]}</span>
                )}
              </button>
            ))}
            <button className="list-row" onClick={() => navigate('/nuevo-local')}>
              <span style={{ color: 'var(--bottle)', fontWeight: 600 }}>Crear otro local</span>
            </button>
          </div>
        </section>

        <section className="section">
          <h2>Cuenta</h2>
          <div className="list">
            <div className="list-row">
              <span className="muted">{session?.user.email}</span>
            </div>
            <button className="list-row" onClick={signOut}>
              <span style={{ color: 'var(--tomato)', fontWeight: 600 }}>Cerrar sesión</span>
            </button>
          </div>
        </section>
      </div>
    </>
  )
}
