-- Pinpoint Shared Storage Schema
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard/project/ebfgjgiiwyoovaccojmu/sql)

create table if not exists public.sessions (
  id text primary key,
  title text not null default 'New Conversation',
  created_at bigint not null,
  messages jsonb default '[]'::jsonb,
  document_name text,
  document_tree jsonb,
  raw_content text
);

-- Enable Row Level Security (RLS)
alter table public.sessions enable row level security;

-- Allow all website users to read and save shared sessions
drop policy if exists "Allow public access to sessions" on public.sessions;
create policy "Allow public access to sessions"
  on public.sessions
  for all
  using (true)
  with check (true);
