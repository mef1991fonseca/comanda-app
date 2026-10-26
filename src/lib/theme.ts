import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'comanda.theme'
const listeners = new Set<(t: ThemeChoice) => void>()

export function getTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

/** Tema efectivo (claro u oscuro) según la elección y el sistema. */
export function effectiveTheme(choice: ThemeChoice = getTheme()): 'light' | 'dark' {
  if (choice !== 'system') return choice
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  // La barra del navegador sigue al tema elegido, no solo al del sistema
  const color = effectiveTheme(choice) === 'dark' ? '#0b0f14' : '#fbf8ff'
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    if (choice === 'system') {
      m.content = m.media.includes('dark') ? '#0b0f14' : '#fbf8ff'
    } else {
      m.content = color
    }
  })
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    /* sin almacenamiento: vale para esta sesión */
  }
  applyTheme(choice)
  listeners.forEach((fn) => fn(choice))
}

export function initTheme() {
  applyTheme(getTheme())
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setState] = useState<ThemeChoice>(getTheme)
  useEffect(() => {
    listeners.add(setState)
    return () => {
      listeners.delete(setState)
    }
  }, [])
  return [theme, setTheme]
}
