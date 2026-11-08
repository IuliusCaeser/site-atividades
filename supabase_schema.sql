-- =====================================================================
--  GUIA DE ATIVIDADES — Esquema do Supabase (PostgreSQL)
--  Cole este script inteiro em: Supabase > SQL Editor > New query > Run
--  É idempotente: pode ser executado mais de uma vez sem quebrar nada.
-- =====================================================================

-- 1) ITENS ------------------------------------------------------------
--  Colunas "fixas" para o que o site/Actions consultam direto, e a
--  coluna `dados` (jsonb) guardando a LINHA COMPLETA do CSV. Assim novas
--  colunas tag_* no CSV funcionam sem alterar o banco.
create table if not exists public.atividades (
  tag_id          text primary key,
  nome_principal  text        not null,
  tag_regiao      text        not null default 'tag_na',
  preco_min       numeric     not null default -1,   -- -1 = sem preço
  preco_max       numeric     not null default -1,
  link_referencia text,
  dados           jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 2) INTERAÇÕES (avaliação, status, prioridade) -------------------------
create table if not exists public.interacoes (
  tag_id       text primary key
               references public.atividades (tag_id) on delete cascade,
  nota         smallint    not null default 0 check (nota between 0 and 5),
  ja_fez       boolean     not null default false,
  quero_fazer  boolean     not null default false,
  prioridade   integer     check (prioridade is null or prioridade > 0),
  favorito     boolean     not null default false,
  odiado       boolean     not null default false,
  updated_at   timestamptz not null default now(),

  -- um item não pode ser favorito e odiado ao mesmo tempo
  constraint chk_fav_odiado check (not (favorito and odiado)),
  -- prioridade só existe quando "quero fazer" = sim
  constraint chk_prioridade check (
    (quero_fazer and prioridade is not null) or
    (not quero_fazer and prioridade is null)
  )
);

create index if not exists idx_interacoes_prioridade on public.interacoes (prioridade) where quero_fazer;
create index if not exists idx_interacoes_nota       on public.interacoes (nota desc)  where nota > 0;
create index if not exists idx_atividades_regiao     on public.atividades (tag_regiao);

-- 3) updated_at automático ----------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_atividades_updated on public.atividades;
create trigger trg_atividades_updated before update on public.atividades
  for each row execute function public.set_updated_at();

drop trigger if exists trg_interacoes_updated on public.interacoes;
create trigger trg_interacoes_updated before update on public.interacoes
  for each row execute function public.set_updated_at();

-- 4) SEGURANÇA (Row Level Security) ---------------------------------------
--  O site usa a chave "anon" (pública). As políticas abaixo permitem ler,
--  inserir e atualizar — mas NÃO apagar. Veja o README sobre endurecer isso
--  (ex.: Supabase Auth) caso o link do site seja divulgado publicamente.
alter table public.atividades enable row level security;
alter table public.interacoes enable row level security;

drop policy if exists "atividades_select" on public.atividades;
drop policy if exists "atividades_insert" on public.atividades;
drop policy if exists "atividades_update" on public.atividades;
create policy "atividades_select" on public.atividades for select to anon, authenticated using (true);
create policy "atividades_insert" on public.atividades for insert to anon, authenticated with check (true);
create policy "atividades_update" on public.atividades for update to anon, authenticated using (true) with check (true);

drop policy if exists "interacoes_select" on public.interacoes;
drop policy if exists "interacoes_insert" on public.interacoes;
drop policy if exists "interacoes_update" on public.interacoes;
create policy "interacoes_select" on public.interacoes for select to anon, authenticated using (true);
create policy "interacoes_insert" on public.interacoes for insert to anon, authenticated with check (true);
create policy "interacoes_update" on public.interacoes for update to anon, authenticated using (true) with check (true);

-- 5) REALTIME (opcional: sincroniza entre celular e computador ao vivo) ---
do $$
begin
  alter publication supabase_realtime add table public.interacoes;
exception when duplicate_object then null;
end $$;
