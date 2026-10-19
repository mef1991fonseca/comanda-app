import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useCurrentRestaurant } from '../lib/restaurant'
import type { Enums } from '../lib/database.types'
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

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export function AppShell() {
  const { role } = useCurrentRestaurant()
  const online = useOnline()

  return (
    <div className="shell">
      {!online && (
        <div className="offline-bar" role="status">
          Sin conexión. Los datos pueden no estar actualizados.
        </div>
      )}
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
      <span className="place">{restaurant.name}</span>
    </header>
  )
}
