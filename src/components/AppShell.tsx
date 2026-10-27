import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useCurrentRestaurant } from '../lib/restaurant'
import { useAuth } from '../lib/auth'
import { onSyncState, syncState } from '../lib/offline'
import { roleLabel } from '../lib/format'
import type { Enums } from '../lib/database.types'
import { SyncBar } from './SyncBar'
import { useKitchenAutoPrint } from '../lib/printer'
import { MenuOrdersBar, MenuOrdersContext } from './MenuOrders'
import { usePendingMenuOrders } from '../lib/menuOrders'
import { IconCaja, IconCocina, IconComandas, IconInicio, IconMas, IconSalon } from './icons'

type Role = Enums<'member_role'>

const tabs: { to: string; label: string; icon: () => JSX.Element; roles: Role[] }[] = [
  { to: '/inicio', label: 'Inicio', icon: IconInicio, roles: ['owner', 'manager'] },
  { to: '/salon', label: 'Salón', icon: IconSalon, roles: ['owner', 'manager', 'cashier', 'waiter'] },
  { to: '/comandas', label: 'Comandas', icon: IconComandas, roles: ['owner', 'manager', 'cashier', 'waiter'] },
  { to: '/cocina', label: 'Cocina', icon: IconCocina, roles: ['kitchen'] },
  { to: '/caja', label: 'Caja', icon: IconCaja, roles: ['owner', 'manager', 'cashier'] },
  { to: '/mas', label: 'Más', icon: IconMas, roles: ['owner', 'manager', 'cashier', 'waiter', 'kitchen'] },
]

export function homeFor(role: Role) {
  if (role === 'kitchen') return '/cocina'
  if (role === 'owner' || role === 'manager') return '/inicio'
  return '/salon'
}

export function AppShell() {
  const { restaurant, role } = useCurrentRestaurant()
  // Si este equipo es la impresora de cocina, imprime cada pedido nuevo
  useKitchenAutoPrint(restaurant.id)
  // Pedidos que mandan los clientes desde la carta QR
  const takesOrders = restaurant.menu_ordering && role !== 'kitchen'
  const { orders: menuOrders, reload: reloadMenuOrders } = usePendingMenuOrders(restaurant.id, takesOrders)
  const [menuOrdersOpen, setMenuOrdersOpen] = useState(false)
  const qr = useMemo(() => ({ orders: menuOrders, openList: () => setMenuOrdersOpen(true) }), [menuOrders])

  return (
    <MenuOrdersContext.Provider value={qr}>
    <div className="shell">
      <SyncBar />
      <MenuOrdersBar
        orders={menuOrders}
        open={menuOrdersOpen}
        setOpen={setMenuOrdersOpen}
        onChanged={() => void reloadMenuOrders()}
      />
      <Outlet />
      <nav className="tabbar" aria-label="Secciones">
        <div className="side-head">
          <span className="side-logo" aria-hidden="true">
            <LogoMark />
          </span>
          <span className="side-brand">Comandá</span>
        </div>
        <div className="side-place">
          <span className="dot" aria-hidden="true" />
          <span className="name">{restaurant.name}</span>
          {restaurant.is_demo && <span className="demo-chip">Demo</span>}
        </div>
        {tabs
          .filter((t) => t.roles.includes(role))
          .map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to}>
              <Icon />
              <span>{label}</span>
              {to === '/salon' && menuOrders.length > 0 && (
                <span className="nav-badge" aria-label={`${menuOrders.length} pedidos de la carta`}>
                  {menuOrders.length}
                </span>
              )}
            </NavLink>
          ))}
        <SideFoot role={role} />
      </nav>
    </div>
    </MenuOrdersContext.Provider>
  )
}

function SideFoot({ role }: { role: Role }) {
  const { session } = useAuth()
  const [online, setOnline] = useState(syncState().online)
  useEffect(() => {
    const off = onSyncState((s) => setOnline(s.online))
    const up = () => setOnline(navigator.onLine)
    window.addEventListener('online', up)
    window.addEventListener('offline', up)
    return () => {
      off()
      window.removeEventListener('online', up)
      window.removeEventListener('offline', up)
    }
  }, [])
  const email = session?.user.email ?? ''
  return (
    <div className="side-foot">
      <div className={online ? 'side-status' : 'side-status off'}>
        <span className="dot" aria-hidden="true" />
        {online ? 'En línea' : 'Sin conexión'}
      </div>
      <div className="side-user">
        <span className="avatar" aria-hidden="true">
          {(email[0] ?? '?').toUpperCase()}
        </span>
        <span className="who">
          <span className="mail">{email}</span>
          <span className="role">{roleLabel[role] ?? role}</span>
        </span>
      </div>
    </div>
  )
}

function LogoMark() {
  return (
    <svg viewBox="0 0 512 512" width="24" height="24">
      <path
        d="M168 132h176a20 20 0 0 1 20 20v228l-32-20-36 20-36-20-36 20-36-20-40 20V152a20 20 0 0 1 20-20Z"
        fill="currentColor"
      />
      <rect x="200" y="196" width="112" height="20" rx="10" fill="var(--primary)" />
      <rect x="200" y="244" width="80" height="20" rx="10" fill="var(--primary)" />
    </svg>
  )
}

export function TopBar({ title }: { title: string }) {
  const { restaurant } = useCurrentRestaurant()
  return (
    <header className="topbar">
      <h1>{title}</h1>
      <span className="place">
        {restaurant.is_demo && <span className="demo-chip">Demo</span>}
        {restaurant.name}
      </span>
    </header>
  )
}
