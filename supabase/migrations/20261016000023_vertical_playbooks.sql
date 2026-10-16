-- The playbook for each sub-vertical: who buys (avatars from our clients' go-to-market strategies), the angles that
-- land with each (from our Hall of Fame and the market's 30+ day ads), and the examples. A name-free version can be
-- shared by link for sales.
create table public.vertical_playbooks (
  vertical_id   uuid primary key references public.verticals(id) on delete cascade,
  summary       text not null default '',
  avatars       jsonb not null default '[]', -- [{ name, who, pains[], triggers[], objections[], angles: [{ name, hook, why, examples: [{ kind, id }] }] }]
  watchouts     jsonb not null default '[]',
  sources       jsonb not null default '{}', -- { clients, fame, market }
  share_token   text unique,
  generated_at  timestamptz,
  fingerprint   text                         -- what it was built from, to know when to rebuild
);
alter table public.vertical_playbooks enable row level security;
create policy "staff read playbooks" on public.vertical_playbooks for select to authenticated using (private.is_staff());
