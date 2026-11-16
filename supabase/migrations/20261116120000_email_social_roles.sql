-- Opening the app to the email team and the organic social team (Nov 2026).
--
-- 1. Six new positions, two per-person switches and five per-client seats.
-- 2. Who sees which clients: the Head of Email sees every client with Email Marketing, the Head of Organic Social every
--    client with Social Media; the other four see only the clients they hold a seat on. None of them see every client:
--    profiles.is_lead (a generated column) stays as it is, so private.sees_all_clients() is false for the new heads.
-- 3. private.sees_paid_ads(): false for the six email and social positions. The paid-ads data tables (Meta, Google,
--    TikTok, KPIs, reports, briefs and requests, audits, launches...) add it to their read rules. Client context (the
--    clients, brand bible, calls, notes, intake, klaviyo_* and social_*) is left alone.
--
-- A new enum value can't be used in the transaction that adds it, so the values are added first and everything after
-- refers to roles as text (role::text). Nothing is deleted.

alter type public.team_role add value if not exists 'head_of_social';
alter type public.team_role add value if not exists 'social_media_manager';
alter type public.team_role add value if not exists 'head_of_email';
alter type public.team_role add value if not exists 'email_strategist';
alter type public.team_role add value if not exists 'email_designer';
alter type public.team_role add value if not exists 'email_builder';

alter type public.assignment_role add value if not exists 'social_manager';
alter type public.assignment_role add value if not exists 'social_creative';
alter type public.assignment_role add value if not exists 'email_strategist';
alter type public.assignment_role add value if not exists 'email_designer';
alter type public.assignment_role add value if not exists 'email_builder';

alter table public.profiles add column if not exists also_social boolean not null default false;
alter table public.profiles add column if not exists also_designs_email boolean not null default false;
comment on column public.profiles.also_social is 'A creative (designer, video editor, lead maker, Head of Creative) who also works on organic social: offered as a social creative on clients with Social Media';
comment on column public.profiles.also_designs_email is 'An email builder who also designs email: offered as an email designer on clients with Email Marketing';

-- Whether the signed-in person sees paid-ads data: everyone except the six email and social positions
create or replace function private.sees_paid_ads()
returns boolean
language sql
stable security definer
set search_path to ''
as $$
  select coalesce((
    select role::text not in ('head_of_social', 'social_media_manager', 'head_of_email', 'email_strategist', 'email_designer', 'email_builder')
    from public.profiles where auth_user_id = auth.uid() and is_active
  ), true)
$$;
revoke all on function private.sees_paid_ads() from public, anon;
grant execute on function private.sees_paid_ads() to authenticated;

-- Which clients someone can see: everyone who sees all, a lead maker (any client), the Head of Email (Email Marketing
-- clients), the Head of Organic Social (Social Media clients), the client's team, or its contacts
create or replace function private.can_see_client(p_client uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $$
  select private.sees_all_clients()
    or private.is_lead_maker()
    or exists (select 1 from public.client_assignments
               where client_id = p_client and profile_id = private.current_profile_id())
    or exists (select 1
               from public.profiles me
               join public.clients c on c.id = p_client and c.archived_at is null
               where me.auth_user_id = auth.uid() and me.is_active
                 and ((me.role::text = 'head_of_email' and 'email-marketing' = any (private.client_services(c)))
                   or (me.role::text = 'head_of_social' and 'social-media' = any (private.client_services(c)))))
    or exists (select 1 from public.contact_clients
               where client_id = p_client and contact_id = private.current_contact_id())
$$;

-- The paid-ads read rules, each with `and private.sees_paid_ads()` added (written out table by table).

drop policy if exists "staff read audits" on public.account_audits;
create policy "staff read audits" on public.account_audits for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read handoffs for their clients" on public.account_handoffs;
create policy "staff read handoffs for their clients" on public.account_handoffs for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read account activity" on public.ad_account_activity;
create policy "staff read account activity" on public.ad_account_activity for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read account changes" on public.ad_account_changes;
create policy "staff read account changes" on public.ad_account_changes for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read ad changes" on public.ad_changes;
create policy "staff read ad changes" on public.ad_changes for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read fatigue" on public.ad_fatigue;
create policy "staff read fatigue" on public.ad_fatigue for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "read angles" on public.angles;
create policy "read angles" on public.angles for select to authenticated
  using ((private.can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read audit why chats" on public.audit_item_messages;
create policy "staff read audit why chats" on public.audit_item_messages for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read brief corrections" on public.brief_corrections;
create policy "staff read brief corrections" on public.brief_corrections for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read campaign goals" on public.campaign_goals;
create policy "staff read campaign goals" on public.campaign_goals for select
  using (((private.current_profile_id() IS NOT NULL)) and (select private.sees_paid_ads()));

drop policy if exists "staff read briefings" on public.client_briefings;
create policy "staff read briefings" on public.client_briefings for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read execution plans" on public.client_execution_plans;
create policy "staff read execution plans" on public.client_execution_plans for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read google gtm" on public.client_google_gtm;
create policy "staff read google gtm" on public.client_google_gtm for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read gtm strategies" on public.client_gtm_strategies;
create policy "staff read gtm strategies" on public.client_gtm_strategies for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read keyword lists" on public.client_keyword_lists;
create policy "staff read keyword lists" on public.client_keyword_lists for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read kickoffs" on public.client_kickoffs;
create policy "staff read kickoffs" on public.client_kickoffs for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read their clients' playbook" on public.client_ledger;
create policy "staff read their clients' playbook" on public.client_ledger for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read client market brands" on public.client_market_brands;
create policy "staff read client market brands" on public.client_market_brands for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read patterns" on public.client_patterns;
create policy "staff read patterns" on public.client_patterns for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read presentation versions" on public.client_presentation_versions;
create policy "staff read presentation versions" on public.client_presentation_versions for select
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read presentations" on public.client_presentations;
create policy "staff read presentations" on public.client_presentations for select
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read report prefs" on public.client_report_prefs;
create policy "staff read report prefs" on public.client_report_prefs for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read client rounds" on public.client_rounds;
create policy "staff read client rounds" on public.client_rounds for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read client tasks" on public.client_tasks;
create policy "staff read client tasks" on public.client_tasks for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read copy chats" on public.copy_chats;
create policy "staff read copy chats" on public.copy_chats for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read copy stars" on public.copy_library_stars;
create policy "staff read copy stars" on public.copy_library_stars for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read copy variations" on public.copy_library_variations;
create policy "staff read copy variations" on public.copy_library_variations for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read overrides" on public.copy_rule_overrides;
create policy "staff read overrides" on public.copy_rule_overrides for select to authenticated
  using (((EXISTS ( SELECT 1 FROM clients c WHERE (c.id = copy_rule_overrides.client_id)))) and (select private.sees_paid_ads()));

drop policy if exists "staff read copy" on public.copy_sets;
create policy "staff read copy" on public.copy_sets for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read creative ai review runs" on public.creative_ai_reviews;
create policy "staff read creative ai review runs" on public.creative_ai_reviews for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read creative drive files" on public.creative_drive_files;
create policy "staff read creative drive files" on public.creative_drive_files for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read creative feedback" on public.creative_feedback;
create policy "staff read creative feedback" on public.creative_feedback for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read disagreements" on public.creative_review_disagreements;
create policy "staff read disagreements" on public.creative_review_disagreements for select to authenticated
  using ((((client_id IS NULL) OR (EXISTS ( SELECT 1 FROM clients c WHERE (c.id = creative_review_disagreements.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "client team reads team briefs" on public.creative_suggestions;
create policy "client team reads team briefs" on public.creative_suggestions for select to authenticated
  using ((((kind = ANY (ARRAY['onboarding'::text, 'call'::text, 'refresh'::text])) AND private.staff_can_see_client(client_id))) and (select private.sees_paid_ads()));

drop policy if exists "staff read design files" on public.design_files;
create policy "staff read design files" on public.design_files for select to authenticated
  using (((EXISTS ( SELECT 1 FROM designs d WHERE ((d.id = design_files.design_id) AND private.staff_can_see_client(d.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "staff read design versions" on public.design_versions;
create policy "staff read design versions" on public.design_versions for select to authenticated
  using (((EXISTS ( SELECT 1 FROM designs d WHERE ((d.id = design_versions.design_id) AND private.staff_can_see_client(d.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "staff read designs" on public.designs;
create policy "staff read designs" on public.designs for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read google days" on public.google_campaign_daily;
create policy "staff read google days" on public.google_campaign_daily for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read google copy" on public.google_copy_assets;
create policy "staff read google copy" on public.google_copy_assets for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read google deploys" on public.google_deploys;
create policy "staff read google deploys" on public.google_deploys for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read google ideas" on public.google_ideas;
create policy "staff read google ideas" on public.google_ideas for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read google market" on public.google_market;
create policy "staff read google market" on public.google_market for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read google playbooks" on public.google_playbooks;
create policy "staff read google playbooks" on public.google_playbooks for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read hall of fame" on public.hall_of_fame;
create policy "staff read hall of fame" on public.hall_of_fame for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read contradiction chats" on public.insight_conflict_messages;
create policy "staff read contradiction chats" on public.insight_conflict_messages for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read kpi snapshots" on public.kpi_snapshots;
create policy "staff read kpi snapshots" on public.kpi_snapshots for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read kpi targets" on public.kpi_targets;
create policy "staff read kpi targets" on public.kpi_targets for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read launch items" on public.launch_items;
create policy "staff read launch items" on public.launch_items for select to authenticated
  using (((EXISTS ( SELECT 1 FROM launch_runs r WHERE ((r.id = launch_items.run_id) AND private.staff_can_see_client(r.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "staff read launch rules for their clients" on public.launch_rules;
create policy "staff read launch rules for their clients" on public.launch_rules for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read launch runs" on public.launch_runs;
create policy "staff read launch runs" on public.launch_runs for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read launch signoffs" on public.launch_signoffs;
create policy "staff read launch signoffs" on public.launch_signoffs for select to authenticated
  using (((private.current_profile_id() IS NOT NULL)) and (select private.sees_paid_ads()));

drop policy if exists "staff read launches for their clients" on public.launches;
create policy "staff read launches for their clients" on public.launches for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read market ads" on public.market_ads;
create policy "staff read market ads" on public.market_ads for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read market brands" on public.market_brands;
create policy "staff read market brands" on public.market_brands for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read buying industry map" on public.media_buying_industry_map;
create policy "staff read buying industry map" on public.media_buying_industry_map for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read buying insights" on public.media_buying_insights;
create policy "staff read buying insights" on public.media_buying_insights for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read meta daily" on public.meta_ad_daily;
create policy "staff read meta daily" on public.meta_ad_daily for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read meta reach" on public.meta_reach;
create policy "staff read meta reach" on public.meta_reach for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read meta snapshots" on public.meta_snapshots;
create policy "staff read meta snapshots" on public.meta_snapshots for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read sprints" on public.optimization_sprints;
create policy "staff read sprints" on public.optimization_sprints for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read policy articles" on public.policy_articles;
create policy "staff read policy articles" on public.policy_articles for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read policy checks" on public.policy_checks;
create policy "staff read policy checks" on public.policy_checks for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read recap decks" on public.recap_decks;
create policy "staff read recap decks" on public.recap_decks for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read recap template maps" on public.recap_template_maps;
create policy "staff read recap template maps" on public.recap_template_maps for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read report bundles" on public.report_bundles;
create policy "staff read report bundles" on public.report_bundles for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read report sends" on public.report_sends;
create policy "staff read report sends" on public.report_sends for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read reports" on public.reports;
create policy "staff read reports" on public.reports for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read request history" on public.request_events;
create policy "staff read request history" on public.request_events for select to authenticated
  using (((EXISTS ( SELECT 1 FROM requests r WHERE ((r.id = request_events.request_id) AND private.staff_can_see_client(r.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "staff read scripts" on public.request_scripts;
create policy "staff read scripts" on public.request_scripts for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read requests" on public.requests;
create policy "staff read requests" on public.requests for select to authenticated
  using (((private.staff_can_see_client(client_id) AND (deleted_at IS NULL))) and (select private.sees_paid_ads()));

drop policy if exists "staff read review comments" on public.review_comments;
create policy "staff read review comments" on public.review_comments for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read shot lists" on public.shot_lists;
create policy "staff read shot lists" on public.shot_lists for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read sprint actions" on public.sprint_actions;
create policy "staff read sprint actions" on public.sprint_actions for select to authenticated
  using (((EXISTS ( SELECT 1 FROM optimization_sprints s WHERE ((s.id = sprint_actions.sprint_id) AND private.staff_can_see_client(s.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "staff read sprint checks" on public.sprint_checks;
create policy "staff read sprint checks" on public.sprint_checks for select to authenticated
  using (((EXISTS ( SELECT 1 FROM optimization_sprints s WHERE ((s.id = sprint_checks.sprint_id) AND private.staff_can_see_client(s.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "client team reads team brief chat" on public.suggestion_messages;
create policy "client team reads team brief chat" on public.suggestion_messages for select to authenticated
  using (((EXISTS ( SELECT 1 FROM creative_suggestions s WHERE ((s.id = suggestion_messages.suggestion_id) AND (s.kind = ANY (ARRAY['onboarding'::text, 'call'::text, 'refresh'::text])) AND private.staff_can_see_client(s.client_id))))) and (select private.sees_paid_ads()));

drop policy if exists "staff read ticket brief chat" on public.ticket_brief_chat;
create policy "staff read ticket brief chat" on public.ticket_brief_chat for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read ticket copy drafts" on public.ticket_copy_drafts;
create policy "staff read ticket copy drafts" on public.ticket_copy_drafts for select to authenticated
  using ((private.staff_can_see_client(client_id)) and (select private.sees_paid_ads()));

drop policy if exists "staff read tiktok ad days" on public.tiktok_ad_daily;
create policy "staff read tiktok ad days" on public.tiktok_ad_daily for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read tiktok ads" on public.tiktok_ads;
create policy "staff read tiktok ads" on public.tiktok_ads for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read tiktok advertisers" on public.tiktok_advertisers;
create policy "staff read tiktok advertisers" on public.tiktok_advertisers for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read tiktok days" on public.tiktok_campaign_daily;
create policy "staff read tiktok days" on public.tiktok_campaign_daily for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read tiktok diagnostics" on public.tiktok_diagnostics;
create policy "staff read tiktok diagnostics" on public.tiktok_diagnostics for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

drop policy if exists "staff read winner insights" on public.winner_insights;
create policy "staff read winner insights" on public.winner_insights for select to authenticated
  using ((private.is_staff()) and (select private.sees_paid_ads()));

-- kpi_targets also has an all-commands rule that reads: the same extra check, for reading and writing
drop policy if exists "staff on the client set kpi targets" on public.kpi_targets;
create policy "staff on the client set kpi targets" on public.kpi_targets for all to authenticated
  using (private.staff_can_see_client(client_id) and (select private.sees_paid_ads()))
  with check (private.staff_can_see_client(client_id) and (select private.sees_paid_ads()));
