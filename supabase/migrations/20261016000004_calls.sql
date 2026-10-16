-- Calls: meeting notes from Gemini (Google Meet) and Fireflies, matched to their client and read by the AI. What was
-- promised on a call is watched: if a creative idea or offer isn't in motion two business days later, a brief is
-- written from the call and put on Home for the client's buyer, leads and execs.

create table public.client_calls (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('gemini', 'fireflies')),
  external_id text not null,
  client_id uuid references public.clients (id) on delete set null, -- null: internal or not matched
  title text not null,
  occurred_at timestamptz not null,
  attendees text[] not null default '{}',
  host text, -- whose notes these are
  url text,
  notes text not null, -- the notes or transcript as written
  summary jsonb, -- the AI's read: summary, what the client said, decisions
  status text not null default 'new' check (status in ('new', 'read', 'internal', 'unmatched', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index client_calls_client on public.client_calls (client_id, occurred_at desc);

-- What was promised on a call, and whether it happened
create table public.call_commitments (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.client_calls (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null check (kind in ('creative', 'copy', 'offer', 'launch', 'strategy', 'other')),
  what text not null,
  why text,
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'in_motion', 'briefed', 'done', 'dismissed')),
  request_numbers int[] not null default '{}',
  suggestion_id uuid,
  dismissed_by uuid references public.profiles (id),
  dismiss_reason text,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);
create index call_commitments_open on public.call_commitments (status, due_at) where status in ('open', 'briefed');

alter table public.client_calls enable row level security;
alter table public.call_commitments enable row level security;
create policy "staff read calls" on public.client_calls for select to authenticated using (client_id is not null and private.staff_can_see_client(client_id) or private.is_exec_or_lead());
create policy "leads match calls" on public.client_calls for update to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());
create policy "staff read commitments" on public.call_commitments for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff update commitments" on public.call_commitments for update to authenticated using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));

-- A brief written from a call: its own kind, seen and acted on by the client's team like a first round
alter table public.creative_suggestions drop constraint creative_suggestions_kind_check;
alter table public.creative_suggestions add constraint creative_suggestions_kind_check check (kind in ('fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner', 'refresh', 'onboarding', 'call'));
alter table public.creative_suggestions add column call_commitment_id uuid references public.call_commitments (id) on delete set null;
drop index public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id) where status = 'open' and kind not in ('lab', 'winner', 'refresh', 'onboarding', 'call');

drop policy "client team reads first round" on public.creative_suggestions;
drop policy "client team edits first round" on public.creative_suggestions;
drop policy "client team reads first round chat" on public.suggestion_messages;
drop policy "client team writes first round chat" on public.suggestion_messages;
create policy "client team reads team briefs" on public.creative_suggestions for select to authenticated
  using (kind in ('onboarding', 'call') and private.staff_can_see_client(client_id));
create policy "client team edits team briefs" on public.creative_suggestions for update to authenticated
  using (kind in ('onboarding', 'call') and private.staff_can_see_client(client_id)) with check (kind in ('onboarding', 'call') and private.staff_can_see_client(client_id));
create policy "client team reads team brief chat" on public.suggestion_messages for select to authenticated
  using (exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.kind in ('onboarding', 'call') and private.staff_can_see_client(s.client_id)));
create policy "client team writes team brief chat" on public.suggestion_messages for insert to authenticated
  with check (role = 'user' and author_id = private.current_profile_id()
    and exists (select 1 from public.creative_suggestions s where s.id = suggestion_id and s.kind in ('onboarding', 'call') and private.staff_can_see_client(s.client_id)));

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('calls', 'Call reader', 'Reads meeting notes from Gemini and Fireflies: what the client said, what was decided, and every commitment made. Watches the commitments, and writes a brief when a creative idea from a call isn''t in motion two business days later.', 'sonnet', 'low', true, 14, 'feed', '{}')
on conflict (key) do nothing;
