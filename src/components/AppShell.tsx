import { NavLink, Outlet } from 'react-router-dom'
import { useCurrentRestaurant } from '../lib/restaurant'
import type { Enums } from '../lib/database.types'
import { SyncBar } from './SyncBar'
import { useKitchenAutoPrint } from '../lib/printer'
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

  return (
    <div className="shell">
      <SyncBar />
      <Outlet />
      <nav className="tabbar" aria-label="Secciones">
        {tabs
          .filter((t) => t.roles.includes(role))
          .map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to}>
              <Icon />
              {label}
            </NavLink>
          ))}
      </nav>
    </div>
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
