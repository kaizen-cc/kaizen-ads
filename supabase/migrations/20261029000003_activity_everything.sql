-- The activity record keeps everything a person does in the app: pages, clicks (what they pressed and where), searches
-- and form submissions, sent in batches by the tracker. Any of it counts as being active.
alter table public.activity_events drop constraint if exists activity_events_kind_check;
alter table public.activity_events add constraint activity_events_kind_check check (kind in ('sign_in', 'page', 'click', 'search', 'submit'));
create index if not exists activity_events_profile_at on public.activity_events (profile_id, at desc);

create or replace function public.activity_log(p_kind text, p_path text, p_label text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.current_profile_id();
begin
  if v_me is null or p_kind not in ('sign_in', 'page') then return; end if;
  if p_kind = 'page' and exists (select 1 from public.activity_events where profile_id = v_me and kind = 'page' and path = p_path and at > now() - interval '1 minute') then return; end if;
  insert into public.activity_events (profile_id, kind, path, label) values (v_me, p_kind, left(p_path, 300), left(p_label, 200));
  if p_kind = 'sign_in' then update public.profiles set last_sign_in_at = now(), last_active_at = now() where id = v_me;
  else update public.profiles set last_active_at = now() where id = v_me; end if;
end $$;

-- A batch from the tracker: [{kind, path, label, at}], at most 50, times no later than now
create or replace function public.activity_log_many(p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := private.current_profile_id();
begin
  if v_me is null or jsonb_typeof(p_items) <> 'array' then return; end if;
  insert into public.activity_events (profile_id, kind, path, label, at)
  select v_me, x->>'kind', left(coalesce(x->>'path', ''), 300), left(coalesce(x->>'label', ''), 200),
         least(now(), greatest(now() - interval '1 hour', coalesce((x->>'at')::timestamptz, now())))
  from (select value as x from jsonb_array_elements(p_items) limit 50) items
  where x->>'kind' in ('click', 'search', 'submit') and coalesce(x->>'label', '') <> '';
  update public.profiles set last_active_at = now() where id = v_me;
end $$;
grant execute on function public.activity_log_many(jsonb) to authenticated;
