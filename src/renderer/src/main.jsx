import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import Report from './Report.jsx'
import Settings from './Settings.jsx'
import Cycles from './Cycles.jsx'
import './styles.css'

const hash = window.location.hash.replace('#', '')
const view = hash === 'report' ? <Report /> : hash === 'settings' ? <Settings /> : hash === 'cycles' ? <Cycles /> : <App />
createRoot(document.getElementById('root')).render(view)
