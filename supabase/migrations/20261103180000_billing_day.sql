-- Creative allotments run on each client's billing cycle, not the calendar month: a client billed on the 15th gets
-- their 60 images from the 15th to the 14th. billing_day (1-28) starts as the day they enrolled (for clients enrolled since the first import); Kaizen Track's
-- service start fills it when it's there, and the team can set it on the client page. Asana work keeps the moment it
-- was counted (counted_at), so it falls in whichever cycle that moment is in.

alter table public.clients add column if not exists billing_day smallint check (billing_day between 1 and 28);
alter table public.clients add column if not exists billing_day_source text check (billing_day_source in ('enrolled', 'track', 'set'));
update public.clients
   set billing_day = least(28, extract(day from (created_at at time zone 'America/New_York'))::int), billing_day_source = 'enrolled'
 where billing_day is null and created_at >= '2026-10-14';
-- Clients brought in by the first import (Oct 13) have no real enrollment day here: they count by the calendar month
-- (billing_day null) until Kaizen Track's service start or the team sets it.

-- A client enrolled from now on: billed from the day they joined, until Track or the team says otherwise
create or replace function public.set_billing_day() returns trigger language plpgsql set search_path = public as $$
begin
  if new.billing_day is null then
    new.billing_day := least(28, extract(day from (now() at time zone 'America/New_York'))::int);
    new.billing_day_source := coalesce(new.billing_day_source, 'enrolled');
  end if;
  return new;
end $$;
drop trigger if exists clients_billing_day on public.clients;
create trigger clients_billing_day before insert on public.clients for each row execute function public.set_billing_day();

alter table public.asana_tasks add column if not exists counted_at timestamptz;
update public.asana_tasks
   set counted_at = case
     when completed_at is not null and date_trunc('month', completed_at at time zone 'America/New_York')::date = counted_month then completed_at
     when asana_modified_at is not null and date_trunc('month', asana_modified_at at time zone 'America/New_York')::date = counted_month then asana_modified_at
     else counted_month::timestamp at time zone 'America/New_York' end
 where counted_month is not null and counted_at is null;

-- The day the current cycle began for a billing day (midnight New York)
create or replace function public.allotment_period_start(p_day int) returns timestamptz
language sql stable set search_path = public as $$
  with t as (select (now() at time zone 'America/New_York')::date as d, greatest(1, least(28, coalesce(p_day, 1))) as b)
  select (case when extract(day from d) >= b then make_date(extract(year from d)::int, extract(month from d)::int, b)
               else (date_trunc('month', d) - interval '1 month')::date + (b - 1) end)::timestamp at time zone 'America/New_York'
  from t
$$;

create or replace view public.client_allotment_usage with (security_invoker = on) as
 WITH cycle AS (
   SELECT c.id AS client_id, public.allotment_period_start(c.billing_day) AS starts FROM public.clients c),
 ours AS (
   SELECT r.client_id,
     sum(r.new_count) FILTER (WHERE r.format = ANY (ARRAY['image'::public.creative_format, 'carousel'::public.creative_format])) AS images,
     sum(r.new_count) FILTER (WHERE r.format = 'video'::public.creative_format) AS videos
   FROM public.requests r
   JOIN cycle y ON y.client_id = r.client_id
   LEFT JOIN public.asana_tasks m ON m.request_id = r.id
   WHERE r.deleted_at IS NULL
     AND CASE WHEN m.counted_at IS NOT NULL THEN m.counted_at >= y.starts
              ELSE COALESCE(m.asana_created_at, r.created_at) >= y.starts END
   GROUP BY r.client_id),
 asana AS (
   SELECT t.client_id,
     sum(COALESCE(t.new_images, CASE WHEN t.format IN ('image', 'carousel') THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_at >= y.starts) AS images,
     sum(COALESCE(t.new_videos, CASE WHEN t.format = 'video' THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_at >= y.starts) AS videos,
     sum(COALESCE(t.new_images, CASE WHEN t.format IN ('image', 'carousel') THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_at IS NULL AND t.open AND t.stage = 'requested') AS waiting_images,
     sum(COALESCE(t.new_videos, CASE WHEN t.format = 'video' THEN 1 ELSE 0 END)) FILTER (WHERE t.counted_at IS NULL AND t.open AND t.stage = 'requested') AS waiting_videos
   FROM public.asana_tasks t
   JOIN cycle y ON y.client_id = t.client_id
   WHERE t.request_id IS NULL
   GROUP BY t.client_id)
 SELECT c.id AS client_id, a.images_per_month, a.videos_per_month,
    (COALESCE(o.images, 0) + COALESCE(s.images, 0))::integer AS images_used,
    (COALESCE(o.videos, 0) + COALESCE(s.videos, 0))::integer AS videos_used,
    c.creative_package_until AS package_until,
    COALESCE(s.images, 0)::integer AS asana_images,
    COALESCE(s.videos, 0)::integer AS asana_videos,
    COALESCE(s.waiting_images, 0)::integer AS asana_waiting_images,
    COALESCE(s.waiting_videos, 0)::integer AS asana_waiting_videos,
    c.billing_day,
    (y.starts AT TIME ZONE 'America/New_York')::date AS period_start,
    ((y.starts AT TIME ZONE 'America/New_York')::date + interval '1 month')::date AS period_end
   FROM public.clients c
     JOIN cycle y ON y.client_id = c.id
     LEFT JOIN public.client_allotments a ON a.client_id = c.id
     LEFT JOIN ours o ON o.client_id = c.id
     LEFT JOIN asana s ON s.client_id = c.id
  WHERE c.creative_package AND c.archived_at IS NULL AND (c.creative_package_until IS NULL OR c.creative_package_until >= (now() AT TIME ZONE 'America/New_York')::date);
