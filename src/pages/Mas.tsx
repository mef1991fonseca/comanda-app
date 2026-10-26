import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { clearCache } from '../lib/offline'
import { useSync } from '../lib/useSync'
import { mpStatus, mpStatusText, type MpStatus } from '../lib/mercadopago'
import { useAuth } from '../lib/auth'
import { useCurrentRestaurant, useRestaurant } from '../lib/restaurant'
import { roleLabel } from '../lib/format'
import type { Enums } from '../lib/database.types'
import { TopBar } from '../components/AppShell'
import { DemoBuilder } from '../components/DemoBuilder'
import { deleteDemo } from '../lib/demo'

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
  const [mp, setMp] = useState<MpStatus | null>(null)
  const [mpError, setMpError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin || !navigator.onLine) return
    void mpStatus(restaurant.id).then(({ data, error }) => {
      setMp(data)
      setMpError(error)
    })
  }, [isAdmin, restaurant.id])

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
              <button className="list-row" onClick={() => navigate('/compras')}>
                <span>Compras y gastos</span>
                <span className="muted">Proveedores, facturas y pagos</span>
              </button>
              <button className="list-row" onClick={() => navigate('/carta/qr')}>
                <span>Carta QR</span>
                <span className="muted">La carta en el celular del cliente</span>
              </button>
              <button className="list-row" onClick={() => navigate('/stock')}>
                <span>Stock</span>
                <span className="muted">Insumos, compras, mermas y conteos</span>
              </button>
              <button className="list-row" onClick={() => navigate('/reportes')}>
                <span>Reportes</span>
                <span className="muted">Ventas, medios de pago y productos</span>
              </button>
              <button className="list-row" onClick={() => navigate('/resultados')}>
                <span>Estado de resultados</span>
                <span className="muted">Ventas menos costo y gastos, mes a mes</span>
              </button>
              <button className="list-row" onClick={() => navigate('/cocina')}>
                <span>Pantalla de cocina</span>
                <span className="muted">Pedidos en preparación</span>
              </button>
            </div>
          </section>
        )}

        {(isAdmin || role === 'cashier') && (
          <section className="section">
            <h2>Cobros</h2>
            <div className="list">
              <button className="list-row" onClick={() => navigate('/clientes')}>
                <span>Clientes y cuentas corrientes</span>
                <span className="muted">Fiado, cuentas de empresas y cobros</span>
              </button>
              {isAdmin && (
              <>
              <button className="list-row" onClick={() => navigate('/facturacion')}>
                <span>Facturación electrónica</span>
                <span className="muted">Datos fiscales y facturas</span>
              </button>
              <button className="list-row" onClick={() => navigate('/mercadopago')}>
                <span className="product-line">
                  <span>Mercado Pago (QR)</span>
                  <span className="product-sub">{mpError ?? mpStatusText(mp)}</span>
                </span>
                {mp?.own ? <span className="badge">Activo</span> : mp && <span className="badge badge-muted">Vincular</span>}
              </button>
              </>
              )}
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
            {!memberships.some((m) => m.restaurant.is_demo) && <DemoBuilder />}
          </div>
        </section>

        {restaurant.is_demo && role === 'owner' && <DemoDelete restaurantId={restaurant.id} />}

        <section className="section">
          <h2>Este equipo</h2>
          <div className="list">
            <button className="list-row" onClick={() => navigate('/impresora')}>
              <span>Impresora</span>
              <span className="muted">Ancho del papel e impresión automática de comandas</span>
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

/** Borrar el local de demostración (con confirmación). Vuelve al otro local, si hay. */
function DemoDelete({ restaurantId }: { restaurantId: string }) {
  const { memberships, select, reload } = useRestaurant()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    const err = await deleteDemo(restaurantId)
    if (err) {
      setBusy(false)
      return setError(err)
    }
    const other = memberships.find((m) => m.restaurant.id !== restaurantId)
    if (other) select(other.restaurant.id)
    await reload()
    navigate('/', { replace: true })
  }

  return (
    <section className="section">
      <h2>Demostración</h2>
      <p className="muted">Este local es de demostración: los datos son inventados y no se mezclan con tus otros locales.</p>
      {confirming ? (
        <div className="notice notice-warn">
          <p style={{ margin: '0 0 10px' }}>Se borra el local con todas sus ventas, cajas, stock y clientes de prueba.</p>
          <div className="sheet-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Borrando…' : 'Borrar la demo'}
            </button>
            <button className="btn btn-quiet" onClick={() => setConfirming(false)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="sheet-actions">
          <button className="btn btn-quiet" onClick={() => setConfirming(true)}>Borrar el local de demostración</button>
        </div>
      )}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
    </section>
  )
}
