-- One-off: read the email Looms again so their method knowledge reaches the email agents (as pending, for approval)
-- and the client-specific ones attach to the client. Run ONLY after the migration 20261118180000_loom_email_social.sql
-- is applied and the app with the new intake is deployed. The cron then reads them a few at a time.
-- Not run yet. Safe to run twice: rows already routed to an email agent, or queued, are left alone.
-- A client's knowledge documents and memory are never duplicated: documents are checked by video link and client,
-- memory notes by their text.

-- How many would be queued (check first)
-- select count(*) from public.loom_videos where <same conditions as below>;

update public.loom_videos
   set status = 'queued', attempts = 0, next_at = now(), error = null, updated_at = now()
 where title ~* '(e-?mail|klaviyo|brevo|sendinblue|customer\.?io|omnisend|mailchimp|newsletter)'
   and status in ('skipped', 'filed', 'review')
   and forced_kind is null
   and transcript is not null and transcript <> ''
   and not (agent_keys && array['role:email_strategist', 'role:email_creative', 'role:email_builder']);

-- Optional, after checking the list: email Looms that were wrongly filed to the Media Buyer's knowledge and buying
-- insights before this. Sets them aside on record (nothing deleted). Review this select first.
-- select id, title from public.loom_videos
--  where title ~* '(e-?mail|klaviyo|brevo|sendinblue|customer\.?io|omnisend|mailchimp|newsletter)' and agent_keys && array['role:media_buyer', 'google_auditor'];
-- update public.media_buying_insights set excluded = true, updated_at = now()
--  where loom_video_id in (select id from public.loom_videos where <the same title match> and agent_keys && array['role:media_buyer', 'google_auditor']);
-- update public.knowledge_docs set removed_at = now()
--  where scope = 'agent' and agent_key in ('role:media_buyer', 'google_auditor') and removed_at is null
--    and id = any (select unnest(doc_ids) from public.loom_videos where <the same title match>);
