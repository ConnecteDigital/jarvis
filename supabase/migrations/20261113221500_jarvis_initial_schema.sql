-- Jarvis: esquema inicial (vigia, regras, alertas, ligações)
-- Já aplicado no projeto Supabase "jarvis" em 13/11/2026.

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null unique,            -- ID da conta no Google Ads (sem hífens)
  name text not null,
  active boolean not null default true,        -- conta vigiada?
  monitor_24h boolean not null default false,  -- pode ligar de madrugada?
  site_url text,                               -- site do cliente, para checar se está no ar
  daily_budget numeric(12,2),                  -- orçamento diário de referência (R$)
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.accounts is 'Contas de clientes do Google Ads vigiadas pelo Jarvis';

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  level text not null check (level in ('critical','attention','routine')),
  enabled boolean not null default true,
  default_params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
comment on table public.rules is 'Regras de alerta: critical liga, attention manda aviso, routine entra no resumo';

create table public.account_rules (
  account_id uuid not null references public.accounts(id) on delete cascade,
  rule_id uuid not null references public.rules(id) on delete cascade,
  enabled boolean not null default true,
  params jsonb not null default '{}'::jsonb,   -- limites específicos desta conta
  primary key (account_id, rule_id)
);
comment on table public.account_rules is 'Ajuste de regra por conta (limites diferentes por cliente)';

create table public.checks (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  metrics jsonb not null default '{}'::jsonb,  -- impressões, cliques, custo, conversões, status
  error text
);
create index checks_account_time_idx on public.checks (account_id, checked_at desc);
comment on table public.checks is 'Cada consulta do vigia a uma conta';

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  rule_id uuid not null references public.rules(id),
  level text not null check (level in ('critical','attention','routine')),
  status text not null default 'open' check (status in ('open','notified','acknowledged','resolved')),
  summary text not null,                       -- o que o Jarvis vai falar
  details jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  notified_at timestamptz,
  resolved_at timestamptz
);
-- só um alerta em aberto por conta e regra: evita ligar duas vezes pelo mesmo problema
create unique index alerts_one_open_per_rule_idx
  on public.alerts (account_id, rule_id)
  where status <> 'resolved';
create index alerts_status_idx on public.alerts (status, opened_at desc);
comment on table public.alerts is 'Problemas detectados pelo vigia';

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid references public.alerts(id) on delete set null,
  direction text not null check (direction in ('outbound','inbound')),
  channel text not null check (channel in ('whatsapp','phone','web')),
  elevenlabs_conversation_id text unique,
  status text not null default 'started' check (status in ('started','answered','no_answer','failed','completed')),
  started_at timestamptz not null default now(),
  duration_seconds integer,
  summary text,
  details jsonb not null default '{}'::jsonb
);
create index calls_started_idx on public.calls (started_at desc);
comment on table public.calls is 'Ligações feitas e recebidas pelo Jarvis';

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references public.calls(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null,
  action text not null,                        -- ex.: pause_campaign, set_budget, update_rule
  params jsonb not null default '{}'::jsonb,
  confirmed boolean not null default false,    -- confirmado por voz antes de executar
  status text not null default 'pending' check (status in ('pending','executed','failed','cancelled')),
  result jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz
);
comment on table public.actions is 'Ações pedidas por voz, com registro de confirmação';

create table public.topups (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  paid_at timestamptz not null default now(),
  note text
);
comment on table public.topups is 'Recargas informadas, para estimar saldo (a API do Google Ads não informa saldo)';

create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.settings is 'Configurações gerais do Jarvis (horários, tentativas, etc.)';

-- Segurança: RLS ligado em tudo e nenhuma política pública.
-- Só o backend, com a chave de serviço, lê e escreve.
alter table public.accounts enable row level security;
alter table public.rules enable row level security;
alter table public.account_rules enable row level security;
alter table public.checks enable row level security;
alter table public.alerts enable row level security;
alter table public.calls enable row level security;
alter table public.actions enable row level security;
alter table public.topups enable row level security;
alter table public.settings enable row level security;

-- Regras iniciais
insert into public.rules (key, name, description, level, default_params) values
  ('stopped_serving', 'Campanha parou de veicular', 'Campanha ativa sem impressões num horário em que normalmente roda', 'critical', '{"window_minutes": 120}'),
  ('site_down', 'Site do cliente fora do ar', 'O site não respondeu em checagens seguidas', 'critical', '{"consecutive_failures": 2}'),
  ('account_suspended', 'Conta suspensa', 'A conta do Google Ads não está ativa', 'critical', '{}'),
  ('ads_disapproved', 'Anúncios reprovados', 'Anúncios reprovados em campanha ativa', 'critical', '{}'),
  ('spend_no_conversion', 'Gasto sem conversão', 'Gasto do dia acima do limite sem nenhuma conversão', 'attention', '{"spend_ratio_of_budget": 0.5}'),
  ('cpa_spike', 'CPA muito acima da média', 'CPA do dia bem acima da média recente da conta', 'attention', '{"multiplier": 2}'),
  ('budget_limited', 'Orçamento limitando campanha', 'Campanha limitada pelo orçamento', 'attention', '{}');

-- Configurações iniciais
insert into public.settings (key, value) values
  ('check_interval_minutes', '60'),
  ('call_hours', '{"start": "07:00", "end": "22:00", "timezone": "America/Sao_Paulo"}'),
  ('call_retry', '{"attempts": 2, "minutes_between": 5}');
