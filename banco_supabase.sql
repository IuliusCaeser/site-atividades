-- =====================================================================
--  GUIA DE ATIVIDADES — Banco + acesso restrito a 2 e-mails
--  E-mails autorizados já preenchidos na função email_autorizado()
--  (seção 5). Basta colar tudo em Supabase > SQL Editor > New query > Run.
--  É idempotente: pode ser executado mais de uma vez.
--
--  IDEIA CENTRAL: as avaliações (estrelas, favorito, etc.) pertencem ao
--  tag_id, e NÃO ao arquivo. Você pode remover ou trocar CSVs à vontade:
--  as interações ficam guardadas e reaparecem quando aquele tag_id voltar
--  a existir em qualquer arquivo.
-- =====================================================================

-- 1) ARQUIVOS importados -------------------------------------------------
create table if not exists public.arquivos (
  id           bigint generated always as identity primary key,
  nome         text        not null unique,
  importado_em timestamptz not null default now()
);

-- 2) ITENS (atividades) ----------------------------------------------------
--  `dados` guarda a LINHA COMPLETA do CSV (novas colunas tag_* funcionam
--  sem alterar o banco). Remover um arquivo remove só as atividades dele.
create table if not exists public.atividades (
  tag_id          text primary key,
  nome_principal  text        not null,
  tag_regiao      text        not null default 'tag_na',
  preco_min       numeric     not null default -1,   -- -1 = sem preço
  preco_max       numeric     not null default -1,
  link_referencia text,
  dados           jsonb       not null default '{}'::jsonb,
  arquivo_id      bigint      references public.arquivos (id) on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 3) INTERAÇÕES (avaliação, status, prioridade) ---------------------------
--  SEM chave estrangeira para atividades, de propósito: apagar uma
--  atividade (ao remover um CSV) nunca apaga suas avaliações.
create table if not exists public.interacoes (
  tag_id       text primary key,
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
create index if not exists idx_atividades_arquivo    on public.atividades (arquivo_id);

-- 4) updated_at automático ----------------------------------------------
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

-- (garantias, caso restem tabelas da versão antiga)
alter table public.atividades add column if not exists arquivo_id bigint references public.arquivos (id) on delete cascade;
alter table public.interacoes drop constraint if exists interacoes_tag_id_fkey;

-- 5) SEGURANÇA: só os 2 e-mails abaixo (logados) entram ------------------
create or replace function public.email_autorizado()
returns boolean
language sql stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'pedroantoniosantos92@gmail.com',
    'carolclube3@gmail.com'
  );
$$;
revoke all on function public.email_autorizado() from public, anon;
grant execute on function public.email_autorizado() to authenticated;

alter table public.arquivos   enable row level security;
alter table public.atividades enable row level security;
alter table public.interacoes enable row level security;

do $$
declare t text; p record;
begin
  -- apaga quaisquer políticas antigas (as abertas para anon)
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('arquivos','atividades','interacoes')
  loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;

  foreach t in array array['arquivos','atividades'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.email_autorizado())', t||'_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.email_autorizado())', t||'_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.email_autorizado()) with check (public.email_autorizado())', t||'_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.email_autorizado())', t||'_delete', t);
  end loop;
end $$;

-- interacoes: ler, criar e editar; NUNCA apagar
create policy "interacoes_select" on public.interacoes for select to authenticated using (public.email_autorizado());
create policy "interacoes_insert" on public.interacoes for insert to authenticated with check (public.email_autorizado());
create policy "interacoes_update" on public.interacoes for update to authenticated using (public.email_autorizado()) with check (public.email_autorizado());

revoke all on public.arquivos, public.atividades, public.interacoes from anon;

-- 5b) Função usada SÓ pelo robô noturno de links (sem login) -----------------
--  Exige o token secreto (o mesmo do secret LINK_CHECK_TOKEN no GitHub) e
--  devolve apenas tag_id, nome e link.
create or replace function public.links_para_checagem(p_token text)
returns table (tag_id text, nome_principal text, link_referencia text)
language plpgsql stable security definer
set search_path = public
as $$
begin
  if p_token is distinct from '454bb05b92309c6ae2fbb55e03c65eef08a87fe4ab82c531' then
    raise exception 'nao autorizado' using errcode = '42501';
  end if;
  return query select a.tag_id, a.nome_principal, a.link_referencia
               from public.atividades a order by a.tag_id;
end $$;
revoke all on function public.links_para_checagem(text) from public;
grant execute on function public.links_para_checagem(text) to anon;

-- 6) REALTIME (opcional: sincroniza entre celular e computador ao vivo) ---
do $$
begin
  alter publication supabase_realtime add table public.interacoes;
exception when duplicate_object then null;
end $$;
