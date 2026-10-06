import { StrictMode } from 'react'
import { createRoot } from '@contsulia/weave'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
