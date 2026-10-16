-- The AI's read of each winning ad: what the numbers show, and why the creative most likely works. Written ahead after
-- every Meta sync (and on demand), so hovering a winner shows it instantly.
create table public.winner_insights (
  ad_id        text primary key,
  client_id    uuid references public.clients(id) on delete cascade,
  observation  text not null,          -- what the numbers show
  creative     text not null,          -- why the creative most likely works
  hook         text,
  angle        text,
  takeaways    text[] not null default '{}',
  metrics      jsonb not null default '{}', -- the numbers it was read from
  generated_at timestamptz not null default now()
);
alter table public.winner_insights enable row level security;
create policy "staff read winner insights" on public.winner_insights for select to authenticated using (private.is_staff());

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('winners', 'Winners analyst', 'Reads every winning ad: what its numbers show against its own account, and why the creative most likely works (the hook, the angle, the format), with takeaways to reuse.', 'sonnet', 'low', true, 17, 'target', '{}')
on conflict (key) do nothing;
