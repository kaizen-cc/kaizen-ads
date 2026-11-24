-- Workspace data retention (Nov 24 2026, Google's Workspace AI Tools Addendum): raw Gmail content isn't kept whole
-- longer than features need. Daily (cron step workspace_retention):
-- 1. context_items from Gmail older than p_keep_days (GMAIL_BODY_KEEP_DAYS, 90 by default): the body cut to its first
--    600 characters and an ellipsis, meta.trimmed = true. Who, when, subject and link stay.
-- 2. owed_replies from Gmail answered or dismissed over 30 days ago: the copied email body and the drafted reply
--    dropped; the gist, sender, subject and dates stay for the history and the counts.
-- Batched so one run never holds a long lock.

create or replace function public.trim_workspace_bodies(p_keep_days integer default 90, p_batch integer default 5000)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n_items integer := 0;
  n_owed integer := 0;
begin
  with old as (
    select id from public.context_items
    where source = 'gmail'
      and occurred_at < now() - make_interval(days => greatest(14, p_keep_days))
      and length(coalesce(body, '')) > 601
      and not coalesce((meta ->> 'trimmed')::boolean, false)
    limit p_batch
  )
  update public.context_items c
    set body = left(c.body, 600) || '…', meta = coalesce(c.meta, '{}'::jsonb) || '{"trimmed": true}'::jsonb
  from old where c.id = old.id;
  get diagnostics n_items = row_count;

  with old as (
    select id from public.owed_replies
    where source = 'gmail'
      and (body is not null or draft is not null)
      and coalesce(answered_at, dismissed_at) < now() - interval '30 days'
    limit p_batch
  )
  update public.owed_replies o set body = null, draft = null
  from old where o.id = old.id;
  get diagnostics n_owed = row_count;

  return jsonb_build_object('emails_trimmed', n_items, 'owed_cleared', n_owed);
end $$;
revoke all on function public.trim_workspace_bodies(integer, integer) from public, anon, authenticated;
grant execute on function public.trim_workspace_bodies(integer, integer) to service_role;
