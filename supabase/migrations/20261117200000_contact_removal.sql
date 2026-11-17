-- Taking a contact off a client, and client emails that change who gets our emails (Nov 2026).
--
-- 1. A contact comes off a client softly: the link stays, marked removed (when, by whom, why, and whether a person on
--    the team or the client's own email did it). Nothing is deleted. Everything that treats a link as "this person is
--    the client's contact" (portal access, report and client emails, approval notices, counts, AI context) reads only
--    links that aren't removed. Adding the person again (by hand, or a later client email) clears the mark.
-- 2. contact_change_requests: each client email asking to add or take people off the list, read from the team's
--    mailboxes once per message (by its Message-ID, so one email in several inboxes is one request), what was asked,
--    and whether it was applied on its own or waits for the team to confirm.

alter table public.contact_clients
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references public.profiles(id) on delete set null,
  add column if not exists removed_reason text,
  add column if not exists removed_source text;

do $$ begin
  alter table public.contact_clients add constraint contact_clients_removed_source_check check (removed_source is null or removed_source in ('client_email', 'team'));
exception when duplicate_object then null; end $$;

comment on column public.contact_clients.removed_at is 'Taken off this client (never deleted): the person no longer gets its emails or portal; adding them again clears it';
comment on column public.contact_clients.removed_reason is 'Why: the client''s own words when their email asked for it, or a note from the team';
comment on column public.contact_clients.removed_source is 'client_email (read from their email) or team (someone on the team)';

create index if not exists contact_clients_active_idx on public.contact_clients (client_id) where removed_at is null;

-- Which clients someone can see: as before, with a contact's access ending when they're taken off the client
create or replace function private.can_see_client(p_client uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $$
  select private.sees_all_clients()
    or private.is_lead_maker()
    or exists (select 1 from public.client_assignments where client_id = p_client and profile_id = private.current_profile_id())
    or exists (select 1 from public.profiles me join public.clients c on c.id = p_client and c.archived_at is null
               where me.auth_user_id = auth.uid() and me.is_active
                 and ((me.role::text = 'head_of_email' and 'email-marketing' = any (private.client_services(c)))
                   or (me.role::text = 'head_of_social' and 'social-media' = any (private.client_services(c)))))
    or exists (select 1 from public.contact_clients where client_id = p_client and contact_id = private.current_contact_id() and removed_at is null)
$$;

-- A contact reads only the brands they're still on
drop policy if exists "contact reads own brands" on public.contact_clients;
create policy "contact reads own brands" on public.contact_clients for select to authenticated
  using (contact_id = private.current_contact_id() and removed_at is null);

-- Adding a contact: as before, and someone taken off earlier is back on (the removal mark cleared)
create or replace function public.add_client_contact(p_client uuid, p_email text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_id    uuid;
begin
  if not private.sees_all_clients() then
    raise exception 'Only execs, leads, the coordinator or the copywriter can add client contacts';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Enter a valid email address';
  end if;
  if v_email like '%@kaizenmarketing.agency' then
    raise exception 'Kaizen team members are added on the Team page, not as client contacts';
  end if;
  if not exists (select 1 from public.clients where id = p_client) then
    raise exception 'Client not found';
  end if;

  insert into public.contacts (email, full_name)
  values (v_email, nullif(trim(p_name), ''))
  on conflict (email) do update
    set full_name = coalesce(public.contacts.full_name, excluded.full_name),
        is_active = true
  returning id into v_id;

  insert into public.contact_clients (contact_id, client_id, is_primary)
  values (v_id, p_client, not exists (select 1 from public.contact_clients where client_id = p_client and removed_at is null))
  on conflict (contact_id, client_id) do update
    set removed_at = null, removed_by = null, removed_reason = null, removed_source = null
    where public.contact_clients.removed_at is not null;

  return v_id;
end $$;

-- Taking a contact off a client: marked removed, never deleted. A primary taken off hands primary to the longest-standing
-- contact left.
drop function if exists public.remove_client_contact(uuid, uuid);
create function public.remove_client_contact(p_client uuid, p_contact uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_was_primary boolean;
begin
  if not private.sees_all_clients() then
    raise exception 'Only execs, leads, the coordinator or the copywriter can remove client contacts';
  end if;
  select is_primary into v_was_primary from public.contact_clients
   where client_id = p_client and contact_id = p_contact and removed_at is null;
  update public.contact_clients
     set removed_at = now(), removed_by = private.current_profile_id(), removed_reason = nullif(trim(p_reason), ''),
         removed_source = 'team', is_primary = false
   where client_id = p_client and contact_id = p_contact and removed_at is null;
  if coalesce(v_was_primary, false) and not exists (select 1 from public.contact_clients where client_id = p_client and removed_at is null and is_primary) then
    update public.contact_clients set is_primary = true
     where (contact_id, client_id) = (select contact_id, client_id from public.contact_clients
                                      where client_id = p_client and removed_at is null order by created_at limit 1);
  end if;
end $$;

revoke execute on function public.add_client_contact(uuid, text, text) from public, anon;
revoke execute on function public.remove_client_contact(uuid, uuid, text) from public, anon;
grant execute on function public.add_client_contact(uuid, text, text) to authenticated;
grant execute on function public.remove_client_contact(uuid, uuid, text) to authenticated;

-- ─── Client emails asking to change who gets our emails ──────────────────────

create table if not exists public.contact_change_requests (
  id uuid primary key default gen_random_uuid(),
  -- The email's Message-ID (the same in every inbox it reached), else mailbox:gmail id
  message_key text not null unique,
  -- The sender and the start of what they wrote: a forward of an email already read is the same request
  content_key text,
  client_id uuid references public.clients(id) on delete cascade,
  mailbox text not null,
  gmail_message_id text not null,
  gmail_thread_id text,
  from_email text not null,
  from_name text,
  -- The teammate who forwarded the client's email into a team mailbox (never applied on its own)
  forwarded_by text,
  -- exact: the sender is one of the client's contacts; domain: only their company's domain matches
  sender_match text not null default 'exact' check (sender_match in ('exact', 'domain')),
  subject text,
  received_at timestamptz not null,
  body text not null,
  quote text,
  -- [{ kind: add|remove, asWritten, email, name, contactId, reason, match, status: applied|pending|dismissed|blocked|undone, note }]
  changes jsonb not null default '[]'::jsonb,
  -- new (to read), applied (on its own), to_confirm (waits for the team), done (all decided), dismissed, nothing (no change asked), superseded
  status text not null default 'new' check (status in ('new', 'applied', 'to_confirm', 'done', 'dismissed', 'nothing', 'superseded')),
  why text,
  attempts int not null default 0,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.contact_change_requests is 'Client emails asking to add or take people off the list that gets our emails: read once per message, applied on their own when it is safe, else waiting for the account team to confirm';

create index if not exists contact_change_requests_client_idx on public.contact_change_requests (client_id, created_at desc);
create index if not exists contact_change_requests_open_idx on public.contact_change_requests (status) where status in ('new', 'to_confirm');
create index if not exists contact_change_requests_content_idx on public.contact_change_requests (content_key);

alter table public.contact_change_requests enable row level security;
-- The team reads their clients' requests; every write is the server's (the cron, and the confirm and undo actions)
create policy "staff read contact changes" on public.contact_change_requests for select to authenticated
  using (client_id is not null and private.staff_can_see_client(client_id));
