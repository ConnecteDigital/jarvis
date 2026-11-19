-- Conversa pelo Telegram: histórico curto e segredo do webhook (gerado no banco).
create table public.chat_messages (
  id bigint generated always as identity primary key,
  chat_id text not null,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index chat_messages_chat_idx on public.chat_messages (chat_id, id desc);
alter table public.chat_messages enable row level security;
comment on table public.chat_messages is 'Histórico da conversa com o Jarvis no Telegram';

insert into public.settings (key, value)
values ('telegram_webhook_secret', to_jsonb(encode(extensions.gen_random_bytes(32), 'hex')))
on conflict (key) do nothing;
