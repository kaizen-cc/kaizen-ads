-- Clients stay in step with the rest of Kaizen, can be archived whole, and arrive with their marketing intake.
--
-- Archive: an archived client disappears from the board, Home, lists and the AI's views, but nothing is deleted.
-- Re-enrolling (the enrollment form, or Kaizen Track making them active again) brings everything back.
alter table public.clients
  add column archived_at timestamptz,
  add column archived_by uuid references public.profiles (id),
  add column archive_reason text,
  add column archived_from public.client_status, -- the status to go back to
  add column archive_source text check (archive_source in ('team', 'track', 'zapier')),
  add column reonboarded_at timestamptz;
create index clients_archived on public.clients (archived_at) where archived_at is not null;

-- The marketing intake form, as the client answered it
create table public.client_intakes (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  client_id uuid references public.clients (id) on delete set null, -- null until matched
  business_name text,
  answers jsonb not null, -- [{ q, a }] in the form's order
  summary jsonb, -- the AI's read: what they sell, who to, offers, voice, what to avoid, goals
  status text not null default 'received' check (status in ('unmatched', 'received', 'read', 'briefed', 'failed')),
  error text,
  received_at timestamptz not null default now()
);
create index client_intakes_client on public.client_intakes (client_id, received_at desc);
alter table public.client_intakes enable row level security;
create policy "staff read intakes" on public.client_intakes for select to authenticated using (client_id is null and private.is_exec_or_lead() or private.staff_can_see_client(client_id));
create policy "leads match intakes" on public.client_intakes for update to authenticated using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());

-- The first round for a new client: its own kind, one open at a time per client
alter table public.creative_suggestions drop constraint creative_suggestions_kind_check;
alter table public.creative_suggestions add constraint creative_suggestions_kind_check check (kind in ('fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner', 'refresh', 'onboarding'));
drop index public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id) where status = 'open' and kind not in ('lab', 'winner', 'refresh', 'onboarding');
create unique index creative_suggestions_one_onboarding on public.creative_suggestions (client_id) where status = 'open' and kind = 'onboarding';

-- Archived clients' tickets leave the board and stop counting (they come back on restore)
create or replace view public.board_requests with (security_invoker = on) as
 SELECT r.id, r.number, r.client_id, r.title, r.format, r.kind, r.priority, r.angle_id, r.audience, r.brief, r.refs, r.sizes, r.quantity,
    r.stage, r.stage_entered_at, r.stage_due_at, r.assignee_id, r.creative_id, r.buyer_id, r.requested_by, r.launched_at, r.created_at,
    r.updated_at, r.batch_id, r.new_count, r.variation_count, r.ai_review, r.landing_url, r.parent_id, r.client_summary, r.deleted_at,
    r.deleted_by, r.delete_reason,
    c.name AS client_name, c.slug AS client_slug, a.full_name AS assignee_name, cr.full_name AS creative_name, b.full_name AS buyer_name,
    an.name AS angle_name, p.number AS parent_number,
    (SELECT count(*)::integer FROM public.request_events e WHERE e.request_id = r.id AND e.kind = 'review' AND (e.data ->> 'decision') = 'changes') AS internal_rounds,
    (SELECT count(*)::integer FROM public.client_rounds cr2 WHERE cr2.request_id = r.id AND cr2.decision = 'revise') AS client_rounds,
    public.business_minutes_between(r.stage_entered_at, now()) AS minutes_in_stage,
    CASE WHEN r.stage_due_at IS NULL THEN 0 ELSE public.business_minutes_between(r.stage_due_at, now()) END AS minutes_over
   FROM public.requests r
     JOIN public.clients c ON c.id = r.client_id
     LEFT JOIN public.profiles a ON a.id = r.assignee_id
     LEFT JOIN public.profiles cr ON cr.id = r.creative_id
     LEFT JOIN public.profiles b ON b.id = r.buyer_id
     LEFT JOIN public.angles an ON an.id = r.angle_id
     LEFT JOIN public.requests p ON p.id = r.parent_id
  WHERE r.deleted_at IS NULL AND c.archived_at IS NULL;

create or replace view public.client_allotment_usage with (security_invoker = on) as
 WITH month AS (SELECT (date_trunc('month', (now() AT TIME ZONE 'America/New_York')) AT TIME ZONE 'America/New_York') AS starts)
 SELECT c.id AS client_id, a.images_per_month, a.videos_per_month,
    COALESCE(sum(r.new_count) FILTER (WHERE r.format = ANY (ARRAY['image'::public.creative_format, 'carousel'::public.creative_format])), 0)::integer AS images_used,
    COALESCE(sum(r.new_count) FILTER (WHERE r.format = 'video'::public.creative_format), 0)::integer AS videos_used,
    c.creative_package_until AS package_until
   FROM public.clients c
     LEFT JOIN public.client_allotments a ON a.client_id = c.id
     LEFT JOIN public.requests r ON r.client_id = c.id AND r.created_at >= (SELECT month.starts FROM month) AND r.deleted_at IS NULL
  WHERE c.creative_package AND c.archived_at IS NULL AND (c.creative_package_until IS NULL OR c.creative_package_until >= (now() AT TIME ZONE 'America/New_York')::date)
  GROUP BY c.id, a.images_per_month, a.videos_per_month, c.creative_package_until;

-- Archive and restore. Execs and leads by hand; the Track mirror and Zapier through the server key.
create function private.archive_client(p_client uuid, p_reason text, p_source text, p_by uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.clients
  set archived_from = case when archived_at is null then status else archived_from end,
      status = 'offboarded', archived_at = coalesce(archived_at, now()), archived_by = p_by,
      archive_reason = nullif(trim(coalesce(p_reason, '')), ''), archive_source = p_source
  where id = p_client;
  -- What was waiting on the team for this client is set aside, not deleted
  update public.creative_suggestions set status = 'expired', updated_at = now() where client_id = p_client and status = 'open';
  update public.ad_fatigue set state = 'dismissed', dismiss_reason = 'Client archived', updated_at = now() where client_id = p_client and state = 'open';
end $$;

create function private.restore_client(p_client uuid, p_status public.client_status) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.clients
  set status = coalesce(p_status, archived_from, 'active'), archived_at = null, archived_by = null, archive_reason = null,
      archived_from = null, archive_source = null
  where id = p_client and archived_at is not null;
end $$;

create function public.archive_client(p_client uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_exec_or_lead() then raise exception 'Only execs and leads can archive a client'; end if;
  perform private.archive_client(p_client, p_reason, 'team', private.current_profile_id());
end $$;

create function public.restore_client(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_exec_or_lead() then raise exception 'Only execs and leads can restore a client'; end if;
  perform private.restore_client(p_client, null);
end $$;

-- For the server (Track mirror, Zapier offboarding)
create function public.system_archive_client(p_client uuid, p_reason text, p_source text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.archive_client(p_client, p_reason, p_source, null);
end $$;
create function public.system_restore_client(p_client uuid, p_status public.client_status) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.restore_client(p_client, p_status);
end $$;

revoke execute on function private.archive_client(uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function private.restore_client(uuid, public.client_status) from public, anon, authenticated;
revoke execute on function public.archive_client(uuid, text) from public, anon;
revoke execute on function public.restore_client(uuid) from public, anon;
grant execute on function public.archive_client(uuid, text) to authenticated;
grant execute on function public.restore_client(uuid) to authenticated;
revoke execute on function public.system_archive_client(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.system_restore_client(uuid, public.client_status) from public, anon, authenticated;
grant execute on function public.system_archive_client(uuid, text, text) to service_role;
grant execute on function public.system_restore_client(uuid, public.client_status) to service_role;

-- Archiving also closes the client's portal (restoring doesn't reopen it by itself)
create or replace function private.archive_client(p_client uuid, p_reason text, p_source text, p_by uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.clients
  set archived_from = case when archived_at is null then status else archived_from end,
      status = 'offboarded', archived_at = coalesce(archived_at, now()), archived_by = p_by,
      archive_reason = nullif(trim(coalesce(p_reason, '')), ''), archive_source = p_source,
      portal_live = false
  where id = p_client;
  update public.creative_suggestions set status = 'expired', updated_at = now() where client_id = p_client and status = 'open';
  update public.ad_fatigue set state = 'dismissed', dismiss_reason = 'Client archived', updated_at = now() where client_id = p_client and state = 'open';
end $$;
revoke execute on function private.archive_client(uuid, text, text, uuid) from public, anon, authenticated;
