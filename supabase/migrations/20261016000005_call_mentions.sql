-- Every call is read per client discussed: a client call is mostly about that client, an internal meeting can cover
-- several. Each client gets its own summary, what was said about them, decisions and promises.
create table public.call_mentions (
  call_id uuid not null references public.client_calls (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  summary jsonb not null,
  primary key (call_id, client_id)
);
create index call_mentions_client on public.call_mentions (client_id);
alter table public.call_mentions enable row level security;
create policy "staff read call mentions" on public.call_mentions for select to authenticated using (private.staff_can_see_client(client_id));

-- Staff see a call when it mentions a client they work on
drop policy "staff read calls" on public.client_calls;
create policy "staff read calls" on public.client_calls for select to authenticated
  using (private.is_exec_or_lead() or (client_id is not null and private.staff_can_see_client(client_id))
    or exists (select 1 from public.call_mentions m where m.call_id = id and private.staff_can_see_client(m.client_id)));
