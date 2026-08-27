-- Execute uma vez no SQL Editor do seu projeto Supabase.
create table if not exists public.regcall_state (
  id text primary key,
  payload jsonb not null default '{"version":1,"rooms":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.regcall_state enable row level security;

-- O backend usa SUPABASE_SECRET_KEY (ou a service_role legada), que ignora RLS.
-- Não exponha essa chave no navegador nem crie políticas públicas para esta tabela.
