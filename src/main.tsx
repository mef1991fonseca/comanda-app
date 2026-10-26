import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/plus-jakarta-sans/800.css'
import './styles.css'
import { AuthProvider } from './lib/auth'
import { RestaurantProvider } from './lib/restaurant'
import { App } from './App'
import { captureInviteFromUrl } from './lib/invites'
import { initTheme } from './lib/theme'

registerSW({ immediate: true })
captureInviteFromUrl()

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RestaurantProvider>
          <App />
        </RestaurantProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
