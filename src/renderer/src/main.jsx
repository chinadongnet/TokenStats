import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import Report from './Report.jsx'
import './styles.css'

const isReport = window.location.hash.replace('#', '') === 'report'
createRoot(document.getElementById('root')).render(isReport ? <Report /> : <App />)
