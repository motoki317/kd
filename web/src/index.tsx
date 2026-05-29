/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { initTheme } from './theme.ts'

// Resolve the saved theme onto <html data-theme> before the first paint to avoid a light→dark flash.
initTheme()

const root = document.getElementById('root')

render(() => <App />, root!)
