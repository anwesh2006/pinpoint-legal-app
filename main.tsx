import React from 'react'
import ReactDOM from 'react-dom/client'
import { Demo } from './demo'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="min-h-screen bg-black text-white flex">
      <Demo />
    </div>
  </React.StrictMode>
)
