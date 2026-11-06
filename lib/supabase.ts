import { createClient } from '@supabase/supabase-js'

export const CENTRAL_SUPABASE_URL = 'https://ebfgjgiiwyoovaccojmu.supabase.co'
export const CENTRAL_SUPABASE_ANON_KEY = 'sb_publishable_wS_aXGkD9BbiWinWkszCxA_TWCH5adt'

// Shared central database instance for all users
export const supabase = createClient(
  (import.meta.env.VITE_SUPABASE_URL as string) || CENTRAL_SUPABASE_URL,
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || CENTRAL_SUPABASE_ANON_KEY
)

export default supabase
