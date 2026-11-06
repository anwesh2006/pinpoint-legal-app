import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseConfig {
  url: string
  anonKey: string
}

export function getSupabaseConfig(): SupabaseConfig {
  const url = localStorage.getItem('SUPABASE_URL') || (import.meta.env.VITE_SUPABASE_URL as string) || ''
  const anonKey = localStorage.getItem('SUPABASE_ANON_KEY') || (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
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
