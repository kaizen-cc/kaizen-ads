-- Exec focus: less noise for the execs. Each exec hears about the lines in their focus, anything personal to them,
-- and every "this client is on fire" alert. Nobody else changes.
-- 1. profiles.exec_focus: the lines an exec owns (meta, google, tiktok, email, social, creative, creative_performance,
--    web, crm, finance). Each exec edits their own (and other execs') in Settings. Empty: not set, hears everything.
-- 2. notifications.line (the line a notification is about) and notifications.fire (a client on fire). Every writer goes
--    through one before-insert trigger that reads the line from the notification's key when the writer didn't set it
--    (a watch flag's line, an ad account's platform, a call promise's kind, a change of direction's tasks...).
-- 3. The same trigger keeps an exec's notification only if it's on fire, personal to them, or on a line in their focus
--    (an escalated client conversation matches by the lines the client buys). The rest is kept on record, out of the
--    way: read, cleared and never emailed, so it never rings or reaches the bell. The same rules live in
--    src/lib/exec-focus/core.ts (with tests); keep the two in step.
-- 4. 'fire' notifications are alerts (the bell), always critical.
-- 5. The focus seeded from what the owner set, and unread exec notifications that don't pass cleared, so the bell is
--    clean today.

alter table public.profiles add column if not exists exec_focus text[] not null default '{}';
alter table public.profiles drop constraint if exists profiles_exec_focus_check;
alter table public.profiles add constraint profiles_exec_focus_check
  check (exec_focus <@ array['meta', 'google', 'tiktok', 'email', 'social', 'creative', 'creative_performance', 'web', 'crm', 'finance']::text[]);
comment on column public.profiles.exec_focus is 'Execs: the lines whose notifications reach them (plus personal ones and clients on fire). Empty: everything.';

alter table public.notifications
  add column if not exists line text,
  add column if not exists fire boolean not null default false;
create index if not exists notifications_fire_day on public.notifications (client_id, created_at) where fire;

-- ─── Lines ───────────────────────────────────────────────────────────────────

-- A line from anything that names one: a focus line, a service slug, an ad platform
create or replace function private.focus_line(p text) returns text language sql immutable set search_path = '' as $$
  select case lower(coalesce(p, ''))
    when 'meta' then 'meta' when 'facebook' then 'meta' when 'instagram' then 'meta' when 'facebook-ads' then 'meta'
    when 'google' then 'google' when 'google-ads' then 'google'
    when 'tiktok' then 'tiktok' when 'tiktok-ads' then 'tiktok'
    when 'email' then 'email' when 'email-marketing' then 'email' when 'klaviyo' then 'email' when 'brevo' then 'email' when 'sms' then 'email'
    when 'social' then 'social' when 'social-media' then 'social'
    when 'creative' then 'creative' when 'creative_performance' then 'creative_performance'
    when 'web' then 'web' when 'web-design' then 'web'
    when 'crm' then 'crm' when 'finance' then 'finance'
    else null end
$$;

-- The line a notification is about, read from its key and kind (null when it has none)
create or replace function private.notice_line(p_kind text, p_key text, p_client uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_p text := split_part(coalesce(p_key, ''), ':', 1);
  v_id text := split_part(coalesce(p_key, ''), ':', 2);
  v_line text; v_kind text; v_text text; n_email int; n_creative int;
begin
  if v_p in ('email-audit', 'email-sprint', 'asana_email') or p_kind in ('email_sprint', 'email_audit') then return 'email'; end if;
  if v_p in ('social-audit', 'social-sprint') or p_kind in ('social_sprint', 'social_audit') then return 'social'; end if;
  if v_p = 'tired' or p_kind = 'fatigue' then return 'creative_performance'; end if;
  if v_p in ('assign', 'buyer', 'ev', 'round', 'ai-review', 'copy-rebut', 'copy-force', 'client-auto', 'client-wait', 'package-gap', 'package-risk') then return 'creative'; end if;
  if v_p = 'site-issues' or p_kind = 'website' then return 'web'; end if;
  if v_p in ('launch', 'launch-dynamic', 'launch-failed', 'launch-moved', 'launch-signoff') then return 'meta'; end if;
  if v_p = 'connection' and p_key like '%meta%' then return 'meta'; end if;
  if v_p = 'ba' then return private.focus_line(split_part(p_key, ':', 3)); end if;
  begin
    if v_p = 'watch' then
      select line, kind into v_line, v_kind from public.watch_flags where id = v_id::uuid;
      if v_kind like 'creative%' then return 'creative'; end if;
      return private.focus_line(v_line);
    elsif v_p = 'off' then
      select platform into v_line from public.kpi_targets where id = v_id::uuid;
      return private.focus_line(v_line);
    elsif v_p = 'auto-audit' then
      select t.platform into v_line from public.account_audits a join public.kpi_targets t on t.id = a.target_id where a.id = v_id::uuid;
      return private.focus_line(v_line);
    elsif v_p = 'promise' then
      select kind, what || ' ' || coalesce(why, '') into v_kind, v_text from public.call_commitments
       where id = (case when v_id = 'n' then split_part(p_key, ':', 3) else v_id end)::uuid;
      if v_text is null then return null; end if;
      if v_text ~* '\m(email|emails|sms|klaviyo|flows?|newsletter)\M' and v_text !~* '\m(meta|google|tiktok|facebook|instagram)\M' then return 'email'; end if;
      if v_kind in ('creative', 'copy', 'offer') then return 'creative'; end if;
      if v_text ~* '\m(google|pmax|performance max|youtube|adwords)\M' then return 'google'; end if;
      if v_text ~* '\mtiktok\M' then return 'tiktok'; end if;
      if v_kind = 'launch' or v_text ~* '\m(meta|facebook|instagram)\M' then return 'meta'; end if;
      return null;
    elsif v_p = 'direction' then
      select count(*) filter (where task_kind in ('email', 'asana_email')), count(*) filter (where task_kind in ('creative', 'asana_creative'))
        into n_email, n_creative from public.direction_change_tasks where change_id = v_id::uuid;
      if n_creative > 0 then return 'creative'; end if;
      if n_email > 0 then return 'email'; end if;
      return null;
    end if;
  exception when others then
    return null;
  end;
  return null;
end $$;

-- ─── Who keeps what ──────────────────────────────────────────────────────────

-- Whether an exec keeps a notification (src/lib/exec-focus/core.ts execKeeps)
create or replace function private.exec_keeps(p_focus text[], p_line text, p_fire boolean, p_kind text, p_key text, p_client uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_p text := split_part(coalesce(p_key, ''), ':', 1);
begin
  if coalesce(p_fire, false) then return true; end if;
  if coalesce(cardinality(p_focus), 0) = 0 then return true; end if;
  -- Personal: what's on them, what they owe or said yes to, what they asked for or must decide
  if v_p not in ('owed-lead', 'said-lead', 'said-moving') and (
       v_p in ('assign', 'buyer', 'asana', 'handoff', 'ev', 'owed', 'owed2', 'said', 'said2', 'agent-ask', 'review-todo', 'task-ready',
               'feedback-reply', 'feedback-review', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'ai-share', 'ai-project',
               'recap', 'assistant-report', 'call-safety', 'agent-heads', 'drift', 'bible-change', 'bible-change-decided',
               'contradiction', 'contradictions', 'connector-ask', 'connector-ready', 'connector-declined', 'saved-used', 'lab-called',
               'lab-note', 'dashboard-question', 'launch-signoff', 'mention', 'ask', 'call-prep')
       or p_kind in ('assigned', 'handoff', 'agent', 'assistant', 'feedback', 'recap', 'mention', 'ask', 'safety')) then
    return true;
  end if;
  if p_line is not null then
    return p_line = any(p_focus) or (p_line = 'creative_performance' and 'creative' = any(p_focus));
  end if;
  -- An escalated client conversation with no line: the lines the client buys
  if v_p in ('owed-lead', 'said-lead', 'said-moving') and p_client is not null then
    return exists (
      select 1 from public.clients c, unnest(private.client_services(c)) s
       where c.id = p_client
         and (private.focus_line(s) = any(p_focus) or (private.focus_line(s) = 'creative_performance' and 'creative' = any(p_focus))));
  end if;
  return false;
end $$;

-- Every notification, whoever writes it: its line, critical when on fire, and an exec's kept only when it passes
create or replace function private.notifications_focus()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_exec boolean; v_focus text[];
begin
  new.line := coalesce(private.focus_line(new.line), private.notice_line(new.kind, new.key, new.client_id));
  if new.fire then new.priority := 'critical'; end if;
  select is_exec, exec_focus into v_exec, v_focus from public.profiles where id = new.profile_id;
  if coalesce(v_exec, false) and not private.exec_keeps(v_focus, new.line, new.fire, new.kind, new.key, new.client_id) then
    -- On record, out of the way: never in the bell, never emailed, never a heads-up
    new.read_at := coalesce(new.read_at, now());
    new.cleared_at := coalesce(new.cleared_at, now());
    new.emailed_at := coalesce(new.emailed_at, now());
  end if;
  return new;
end $$;
drop trigger if exists notifications_focus on public.notifications;
create trigger notifications_focus
  before insert on public.notifications
  for each row execute function private.notifications_focus();

revoke execute on function private.notice_line(text, text, uuid) from public, anon, authenticated;
revoke execute on function private.exec_keeps(text[], text, boolean, text, text, uuid) from public, anon, authenticated;

-- ─── The bell: 'fire' notices are alerts. Every existing prefix is kept
drop index if exists public.notifications_alert_unread;
alter table public.notifications drop column if exists alert;
alter table public.notifications add column alert boolean generated always as (
  split_part(coalesce(key, ''), ':', 1) in ('owed', 'owed2', 'said', 'said2', 'assign', 'asana', 'report-remind', 'report-part', 'handoff', 'launch', 'auto-audit', 'off', 'check', 'sheet-unknown-buyers', 'contradiction', 'contradictions', 'connection', 'saved-used', 'feedback-fixed', 'feedback-digest', 'feedback-urgent', 'feedback-review', 'feedback-reply', 'bible-review', 'bible-digest', 'client-wait', 'connector-ask', 'connector-ready', 'connector-declined', 'direction', 'watch', 'promise', 'fire')
  or (kind = 'ticket' and priority = 'critical')
) stored;
create index if not exists notifications_alert_unread on public.notifications (profile_id, alert) where read_at is null and cleared_at is null;

-- ─── Seed: the focus the owner set for each exec (matched once here, by name or email; code never names anyone)
update public.profiles set exec_focus = array['meta', 'google', 'tiktok', 'creative_performance']
 where is_exec and (lower(full_name) like 'kyle%barry%' or lower(email) like 'kyle%');
update public.profiles set exec_focus = array['email']
 where is_exec and (lower(full_name) like 'santi%lozano%' or lower(full_name) like 'santiago%lozano%' or lower(email) like 'santi%');
update public.profiles set exec_focus = array['social', 'creative']
 where is_exec and (lower(full_name) like 'ryan%brand%' or lower(email) like 'ryan%');

-- ─── Clean up: unread exec notifications classified, and the ones that don't pass cleared
update public.notifications n
   set line = private.notice_line(n.kind, n.key, n.client_id)
 where n.line is null and n.read_at is null and n.cleared_at is null
   and exists (select 1 from public.profiles p where p.id = n.profile_id and p.is_exec);

update public.notifications n
   set cleared_at = now(), emailed_at = coalesce(n.emailed_at, now())
  from public.profiles p
 where p.id = n.profile_id and p.is_exec
   and n.read_at is null and n.cleared_at is null
   and not private.exec_keeps(p.exec_focus, n.line, n.fire, n.kind, n.key, n.client_id);

-- Heads-ups queued for what was just cleared don't ring
do $$
begin
  if to_regclass('public.assistant_heads_up_items') is not null then
    delete from public.assistant_heads_up_items h
     using public.notifications n, public.profiles p
     where h.heads_up_id is null and h.profile_id = n.profile_id and h.key = 'n:' || n.key
       and p.id = n.profile_id and p.is_exec and n.read_at is null and n.cleared_at = now();
  end if;
end $$;
