import { createRoot } from 'react-dom/client'
import App from './App'

const element = document.getElementById('root')
if (!element) throw new Error('Renderer root is missing')
createRoot(element).render(<App />)
