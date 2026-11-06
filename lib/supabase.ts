import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseConfig {
  url: string
  anonKey: string
}

export function getSupabaseConfig(): SupabaseConfig {
  let url = localStorage.getItem('SUPABASE_URL') || (import.meta.env.VITE_SUPABASE_URL as string) || ''
  if (url) {
    url = url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')
  }
  const anonKey = (localStorage.getItem('SUPABASE_ANON_KEY') || (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || '').trim()
  return { url, anonKey }
}

export function initSupabase(): SupabaseClient | null {
  const { url, anonKey } = getSupabaseConfig()
  if (url && anonKey) {
    try {
      return createClient(url, anonKey)
    } catch (e) {
      console.error('Supabase init failed', e)
      return null
    }
  }
  return null
}
