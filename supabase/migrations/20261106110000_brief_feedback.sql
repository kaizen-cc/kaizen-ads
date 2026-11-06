-- Head of Creative feedback on briefing (Nov 6 2026).
-- 1. In progress next to used: what's on the board or in Asana for a client and not delivered yet (requested, in
--    production, in review, copy, with the client, client changes), per pool, so nobody overproduces against "0 of 25".
-- 2. Avatar and angle on every request: the avatar is one of the client's Brand Bible audience profiles (or a new one
--    under test), kept on the ticket so creatives can name files and folders by avatar and angle.
-- 3. Background briefs: a person's own jobs are read by profile id (profiles.id is not the auth uid), so the card's
--    progress, the toast and "Brief ready" reach them.
-- 4. Saved references: any pasted link (Motion, Pinterest, Instagram, TikTok, Ads Library, YouTube, any page).

alter table public.requests
  add column if not exists avatar text,
  add column if not exists avatar_test boolean not null default false;

comment on column public.requests.avatar is 'The Brand Bible avatar (audience profile) this request is for, by name; a new avatar under test when avatar_test';
comment on column public.requests.avatar_test is 'The request tests an avatar that is not in the Brand Bible yet';

create or replace view public.board_requests with (security_invoker = on) as
 SELECT r.id,
    r.number,
    r.client_id,
    r.title,
    r.format,
    r.kind,
    r.priority,
    r.angle_id,
    r.audience,
    r.brief,
    r.refs,
    r.sizes,
    r.quantity,
    r.stage,
    r.stage_entered_at,
    r.stage_due_at,
    r.assignee_id,
    r.creative_id,
    r.buyer_id,
    r.requested_by,
    r.launched_at,
    r.created_at,
    r.updated_at,
    r.batch_id,
    r.new_count,
    r.variation_count,
    r.ai_review,
    r.landing_url,
    r.parent_id,
    r.client_summary,
    r.deleted_at,
    r.deleted_by,
    r.delete_reason,
    c.name AS client_name,
    c.slug AS client_slug,
    a.full_name AS assignee_name,
    cr.full_name AS creative_name,
    b.full_name AS buyer_name,
    an.name AS angle_name,
    p.number AS parent_number,
    ( SELECT count(*)::integer AS count
           FROM request_events e
          WHERE e.request_id = r.id AND e.kind = 'review'::text AND (e.data ->> 'decision'::text) = 'changes'::text) AS internal_rounds,
    ( SELECT count(*)::integer AS count
           FROM client_rounds cr2
          WHERE cr2.request_id = r.id AND cr2.decision = 'revise'::text) AS client_rounds,
    business_minutes_between(r.stage_entered_at, now()) AS minutes_in_stage,
        CASE
            WHEN r.stage_due_at IS NULL THEN 0
            ELSE business_minutes_between(r.stage_due_at, now())
        END AS minutes_over,
    r.origin,
    r.avatar,
    r.avatar_test
   FROM requests r
     JOIN clients c ON c.id = r.client_id
     LEFT JOIN profiles a ON a.id = r.assignee_id
     LEFT JOIN profiles cr ON cr.id = r.creative_id
     LEFT JOIN profiles b ON b.id = r.buyer_id
     LEFT JOIN angles an ON an.id = r.angle_id
     LEFT JOIN requests p ON p.id = r.parent_id
  WHERE r.deleted_at IS NULL AND c.archived_at IS NULL;

create or replace view public.client_allotment_usage with (security_invoker = on) as
 WITH cycle AS (
         SELECT c_1.id AS client_id,
            allotment_period_start(c_1.billing_day::integer) AS starts
           FROM clients c_1
        ), ours AS (
         SELECT r.client_id,
            sum(r.allotment_units) FILTER (WHERE r.format = ANY (ARRAY['image'::creative_format, 'carousel'::creative_format])) AS images,
            sum(r.allotment_units) FILTER (WHERE r.format = 'video'::creative_format) AS videos
           FROM requests r
             JOIN cycle y_1 ON y_1.client_id = r.client_id
             LEFT JOIN asana_tasks m ON m.request_id = r.id
          WHERE r.deleted_at IS NULL AND
                CASE
                    WHEN m.counted_at IS NOT NULL THEN m.counted_at >= y_1.starts
                    ELSE COALESCE(m.asana_created_at, r.created_at) >= y_1.starts
                END
          GROUP BY r.client_id
        ), asana AS (
         SELECT t.client_id,
            sum(COALESCE(t.new_images,
                CASE
                    WHEN t.format = ANY (ARRAY['image'::text, 'carousel'::text]) THEN 1
                    ELSE 0
                END)) FILTER (WHERE t.counted_at >= y_1.starts) AS images,
            sum(COALESCE(t.new_videos,
                CASE
                    WHEN t.format = 'video'::text THEN 1
                    ELSE 0
                END)) FILTER (WHERE t.counted_at >= y_1.starts) AS videos,
            sum(COALESCE(t.new_images,
                CASE
                    WHEN t.format = ANY (ARRAY['image'::text, 'carousel'::text]) THEN 1
                    ELSE 0
                END)) FILTER (WHERE t.counted_at IS NULL AND t.open AND t.stage = 'requested'::text) AS waiting_images,
            sum(COALESCE(t.new_videos,
                CASE
                    WHEN t.format = 'video'::text THEN 1
                    ELSE 0
                END)) FILTER (WHERE t.counted_at IS NULL AND t.open AND t.stage = 'requested'::text) AS waiting_videos
           FROM asana_tasks t
             JOIN cycle y_1 ON y_1.client_id = t.client_id
          WHERE t.request_id IS NULL
          GROUP BY t.client_id
        ), progress AS (
         -- Not delivered yet, whatever cycle it was asked in: tickets before "Ready to launch", and Asana tasks (not
         -- moved to a ticket) still open in a stage before it
         SELECT x.client_id,
            sum(x.images) AS images,
            sum(x.videos) AS videos
           FROM ( SELECT r.client_id,
                    CASE WHEN r.format = ANY (ARRAY['image'::creative_format, 'carousel'::creative_format]) THEN COALESCE(r.allotment_units, 0) ELSE 0 END AS images,
                    CASE WHEN r.format = 'video'::creative_format THEN COALESCE(r.allotment_units, 0) ELSE 0 END AS videos
                   FROM requests r
                  WHERE r.deleted_at IS NULL AND r.stage <> ALL (ARRAY['ready_for_launch'::request_stage, 'launched'::request_stage])
                UNION ALL
                 SELECT t.client_id,
                    COALESCE(t.new_images, CASE WHEN t.format = ANY (ARRAY['image'::text, 'carousel'::text]) THEN 1 ELSE 0 END) AS images,
                    COALESCE(t.new_videos, CASE WHEN t.format = 'video'::text THEN 1 ELSE 0 END) AS videos
                   FROM asana_tasks t
                  WHERE t.request_id IS NULL AND t.open AND t.client_id IS NOT NULL AND COALESCE(t.stage, 'requested'::text) = ANY (ARRAY['requested'::text, 'in_production'::text, 'internal_review'::text, 'copy'::text, 'copy_review'::text, 'ready_for_client'::text, 'client_review'::text, 'client_revision'::text])) x
          GROUP BY x.client_id
        )
 SELECT c.id AS client_id,
    a.images_per_month,
    a.videos_per_month,
    (COALESCE(o.images, 0::bigint) + COALESCE(s.images, 0::bigint))::integer AS images_used,
    (COALESCE(o.videos, 0::bigint) + COALESCE(s.videos, 0::bigint))::integer AS videos_used,
    c.creative_package_until AS package_until,
    COALESCE(s.images, 0::bigint)::integer AS asana_images,
    COALESCE(s.videos, 0::bigint)::integer AS asana_videos,
    COALESCE(s.waiting_images, 0::bigint)::integer AS asana_waiting_images,
    COALESCE(s.waiting_videos, 0::bigint)::integer AS asana_waiting_videos,
    c.billing_day,
    (y.starts AT TIME ZONE 'America/New_York'::text)::date AS period_start,
    ((y.starts AT TIME ZONE 'America/New_York'::text)::date + '1 mon'::interval)::date AS period_end,
    COALESCE(g.images, 0::bigint)::integer AS progress_images,
    COALESCE(g.videos, 0::bigint)::integer AS progress_videos
   FROM clients c
     JOIN cycle y ON y.client_id = c.id
     LEFT JOIN client_allotments a ON a.client_id = c.id
     LEFT JOIN ours o ON o.client_id = c.id
     LEFT JOIN asana s ON s.client_id = c.id
     LEFT JOIN progress g ON g.client_id = c.id
  WHERE c.creative_package AND c.archived_at IS NULL AND (c.creative_package_until IS NULL OR c.creative_package_until >= (now() AT TIME ZONE 'America/New_York'::text)::date);

-- A person's own background briefs, by their profile (profiles.id differs from auth.uid())
drop policy if exists "brief jobs: own" on public.brief_jobs;
create policy "brief jobs: own" on public.brief_jobs for select to authenticated using (profile_id = (select private.current_profile_id()));

-- Any pasted link can be saved for later, per person per client
alter table public.client_saved_references drop constraint if exists client_saved_references_source_check;
alter table public.client_saved_references add constraint client_saved_references_source_check
  check (source = any (array['market', 'winner', 'pattern', 'brief', 'fatigue', 'promise', 'audit_idea', 'ai', 'idea', 'link']));
