import { createRoot } from 'react-dom/client'
import App from './App'
import PetApp from './pet/PetApp'

const element = document.getElementById('root')
if (!element) throw new Error('Renderer root is missing')
createRoot(element).render(new URLSearchParams(location.search).has('pet') ? <PetApp /> : <App />)
