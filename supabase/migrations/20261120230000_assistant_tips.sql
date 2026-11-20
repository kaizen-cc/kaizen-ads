-- What each person can do with their assistant and when they last did it, for "did you know" tips about things they
-- haven't tried (or haven't in a while). One row per person per tip (a group of the assistant's tools).
create table if not exists public.assistant_tips (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  tip text not null,
  seen_at timestamptz not null default now(),   -- last call where they had these tools
  used_at timestamptz,                          -- last time the assistant used one of them for them
  uses integer not null default 0,
  tipped_at timestamptz,                        -- last time a hello told them about it
  primary key (profile_id, tip)
);

alter table public.assistant_tips enable row level security;
create policy "assistant_tips own read" on public.assistant_tips for select to authenticated using (profile_id = (select private.current_profile_id()));

-- Their tools on this call: the tips they make possible (new ones added, seen ones refreshed)
create or replace function public.assistant_tips_seen(p uuid, tips text[]) returns void language sql security definer set search_path = public as $$
  insert into assistant_tips (profile_id, tip) select p, unnest(tips)
  on conflict (profile_id, tip) do update set seen_at = now();
$$;

-- The assistant used one of them for them
create or replace function public.assistant_tip_used(p uuid, t text) returns void language sql security definer set search_path = public as $$
  insert into assistant_tips (profile_id, tip, used_at, uses) values (p, t, now(), 1)
  on conflict (profile_id, tip) do update set used_at = now(), uses = assistant_tips.uses + 1, seen_at = now();
$$;

revoke all on function public.assistant_tips_seen(uuid, text[]) from public, anon, authenticated;
revoke all on function public.assistant_tip_used(uuid, text) from public, anon, authenticated;
