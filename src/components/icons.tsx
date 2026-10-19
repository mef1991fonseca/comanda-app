import type { SVGProps } from 'react'

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export const IconSalon = () => (
  <svg {...base}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)

export const IconComandas = () => (
  <svg {...base}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
    <path d="M9 8h6M9 12h4" />
  </svg>
)

export const IconCocina = () => (
  <svg {...base}>
    <path d="M6 13h12v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6Z" />
    <path d="M4 13h16" />
    <path d="M9 9c0-1.5 1-2 1-3.5M13 9c0-1.5 1-2 1-3.5" />
  </svg>
)

export const IconCaja = () => (
  <svg {...base}>
    <rect x="3" y="8" width="18" height="12" rx="2" />
    <path d="M7 8V5h10v3" />
    <circle cx="12" cy="14" r="2.5" />
  </svg>
)

export const IconMas = () => (
  <svg {...base}>
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </svg>
)

export const IconInicio = () => (
  <svg {...base}>
    <path d="M4 20V10l8-6 8 6v10" />
    <path d="M9 20v-5h6v5" />
  </svg>
)
