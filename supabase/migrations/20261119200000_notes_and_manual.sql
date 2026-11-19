-- Anotações por cliente, consultadas e escritas pelo Jarvis no Telegram.
create table public.account_notes (
  id bigint generated always as identity primary key,
  customer_id text not null,
  account_name text not null default '',
  note text not null,
  created_at timestamptz not null default now()
);
create index account_notes_customer_idx on public.account_notes (customer_id);
alter table public.account_notes enable row level security;
comment on table public.account_notes is 'Anotações por cliente (preferências, restrições, histórico)';
-- O manual da Connect fica em settings.manual (texto), editável sem publicar código.
