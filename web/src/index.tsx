/* @refresh reload */
import { render } from 'solid-js/web'
// IBM Plex (latin subsets): Sans for chrome, Mono for data — see tokens.css --font-ui/--font-mono.
// Three weights each: 400 body, 500 medium emphasis, 600 titles/labels.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './index.css'
import App from './App.tsx'
import { initTheme } from './theme.ts'

// Resolve the saved theme onto <html data-theme> before the first paint to avoid a light→dark flash.
initTheme()

const root = document.getElementById('root')

render(() => <App />, root!)
