-- Knowledge the agents read: PDFs (and Word, PowerPoint, pictures of documents, text) added to one agent, to every
-- agent, to the Ads Lab library or to one client. Each is read once into clean text, a title, a summary and key points,
-- and cut into chunks with page references; a call gets only the chunks that match its task, never whole documents.

insert into storage.buckets (id, name, public, file_size_limit)
values ('knowledge', 'knowledge', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

create table if not exists public.knowledge_docs (
  id uuid primary key default gen_random_uuid(),
  -- agent: one agent's knowledge · shared: every agent · lab: the Ads Lab library · client: one client only
  scope text not null check (scope in ('agent', 'shared', 'lab', 'client')),
  agent_key text,
  client_id uuid references public.clients(id) on delete cascade,
  name text not null,
  path text not null,
  mime text,
  bytes bigint,
  title text,
  summary text,
  key_points jsonb not null default '[]'::jsonb,
  pages int,
  text text,
  status text not null default 'reading' check (status in ('reading', 'ready', 'failed')),
  progress int not null default 0,
  note text,
  -- How it was read: the file's own text, or the AI reading the pages (scans, pictures)
  method text,
  -- Client knowledge is never deleted: set aside as background, it's read last and only when it matches strongly
  background boolean not null default false,
  -- Agent, shared and Lab knowledge can be removed (kept for the record, no longer read)
  removed_at timestamptz,
  lab_source_id uuid,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'agent') = (agent_key is not null)),
  check ((scope = 'client') = (client_id is not null))
);
create index if not exists knowledge_docs_scope on public.knowledge_docs (scope, agent_key, client_id) where removed_at is null;

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references public.knowledge_docs(id) on delete cascade,
  idx int not null,
  page_from int,
  page_to int,
  heading text,
  body text not null,
  tsv tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || body)) stored
);
create index if not exists knowledge_chunks_doc on public.knowledge_chunks (doc_id, idx);
create index if not exists knowledge_chunks_tsv on public.knowledge_chunks using gin (tsv);

alter table public.knowledge_docs enable row level security;
alter table public.knowledge_chunks enable row level security;
drop policy if exists "staff read knowledge docs" on public.knowledge_docs;
create policy "staff read knowledge docs" on public.knowledge_docs for select to authenticated using (private.is_staff());
drop policy if exists "staff read knowledge chunks" on public.knowledge_chunks;
create policy "staff read knowledge chunks" on public.knowledge_chunks for select to authenticated using (private.is_staff());

-- The chunks of these documents that best match a task (any of its words, ranked by how closely they cover it)
create or replace function public.match_knowledge(p_query text, p_docs uuid[], p_limit int default 12)
returns table (doc_id uuid, idx int, page_from int, page_to int, heading text, body text, rank real)
language sql stable set search_path = public as $$
  with words as (
    select string_agg(distinct quote_literal(lexeme), ' | ') as q
    from unnest(to_tsvector('english', left(coalesce(p_query, ''), 20000)))
    -- Numbers and two-letter words match everything; they don't say what the task is about
    where length(lexeme) >= 3 and lexeme !~ '^[0-9]+$'
  ), q as (
    select to_tsquery('english', coalesce(nullif((select q from words), ''), quote_literal('zzzzqqqq'))) as q
  )
  select c.doc_id, c.idx, c.page_from, c.page_to, c.heading, c.body, ts_rank_cd(c.tsv, q.q, 32)::real as rank
  from public.knowledge_chunks c, q
  where c.doc_id = any(p_docs) and c.tsv @@ q.q
  order by rank desc
  limit greatest(1, least(p_limit, 40));
$$;
revoke all on function public.match_knowledge(text, uuid[], int) from public, anon, authenticated;
grant execute on function public.match_knowledge(text, uuid[], int) to service_role;
