-- The Tracking Engineer (Nov 20 2026): an expert AI agent for Kaizen's tracking specialist, a seventh role agent with
-- two skills, in the "Strategy and whole team" line (it serves every line). Its key is tracking_engineer, not
-- tracking_specialist, so it never collides with the team position of that name. Execs and the Heads of Meta and
-- Google teach it (src/lib/agent-access.ts); everyone can talk to it.
--   tracking_audit  reads a client's setup and numbers and answers with numbered steps (src/lib/tracking-agent.ts)
--   tracking_desk   answers tracking questions in chat and on calls
-- Its playbook (Meta Pixel + CAPI, GTM web and server-side, GA4, Google Ads conversions, Shopify, GoHighLevel, TikTok
-- Events API, UTMs and windows, a breakage field guide) is filed to its knowledge by the cron, from the docs.
-- tracking_checks keeps each check (asked, or proactive on a tracking flag or a conversion-rate drop).

insert into public.ai_roles (key, label, description, icon, core, sort_order)
select 'tracking_engineer', 'Tracking Engineer',
  'The measurement expert: server-side tracking, Meta Pixel and Conversions API, Google Tag Manager (web and server), GA4, Google Ads conversions, Shopify and GoHighLevel tracking, TikTok Events API and UTMs. Reads a client''s setup and numbers and says what to check or fix, step by step.',
  'scan',
  'You are Kaizen''s Tracking Engineer: the expert resource for the tracking specialist, and for media buyers and anyone who asks. You know server-side tracking, the Meta Pixel and Conversions API (deduplication with event_id, Event Match Quality, domain verification and event configuration), Google Tag Manager web and server-side containers, GA4 (events, key events, cross-domain, consent mode v2), Google Ads conversion tracking (primary and secondary, enhanced conversions, offline imports), Shopify''s app and custom pixels under checkout extensibility, GoHighLevel tracking and webhooks, the TikTok Events API, UTMs and every platform''s attribution windows.
How you work:
- The backend is the truth: store orders, CRM leads and booked calls. Compare platforms to it by day, and explain normal gaps (windows, view-through, modeling) apart from broken ones (double firing, missing events).
- Diagnose in order: is it firing, is it firing once, are the values right, is it matched, is the ad set optimizing to it, does it match the backend.
- Answer with numbered steps: the action, exactly where to click or look, what good looks like, and who does it (the tracking specialist, the media buyer, the client''s developer, or the client).
- Read the client''s real setup and numbers before you advise (get the client''s tracking with the tracking_check tool); when something isn''t known, finding it out is the first step.
- Never ask for passwords or keys; access goes through the platforms'' own user invites. Use Kaizen''s roles, never people''s names.',
  12
where not exists (select 1 from public.ai_roles where key = 'tracking_engineer');

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select 'tracking_audit', 'Tracking check',
  'Reads one client''s tracking: the conversion events and their 3 to 90 day numbers, audit findings about tracking, open watchdog flags, the weekly review''s platform-vs-store orders and the store and CRM connections, and answers with what''s likely wrong and numbered steps to check or fix it. Runs on request and on its own when a tracking flag opens or the conversion rate drops suddenly.',
  'sonnet', 'medium', true, 120, '{}'::jsonb, 'tracking_engineer',
  'Start from the backend (orders, leads) against what the platforms count. Name the likeliest cause first, with the evidence. Steps are concrete and in order; at most eight.'
where not exists (select 1 from public.ai_agents where key = 'tracking_audit');

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select 'tracking_desk', 'Tracking desk',
  'Answers tracking questions from the tracking specialist, media buyers and the team in chat and on calls: setups, breakages, discrepancies between platforms, GA4 and the backend, and how to fix them.',
  'sonnet', 'medium', true, 121, '{}'::jsonb, 'tracking_engineer',
  'Short and practical. Numbered steps when there''s something to do. Say when a gap is normal and when it''s broken.'
where not exists (select 1 from public.ai_agents where key = 'tracking_desk');

create table if not exists public.tracking_checks (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  trigger     text,
  question    text,
  result      jsonb not null default '{}'::jsonb,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists tracking_checks_client on public.tracking_checks (client_id, created_at desc);
alter table public.tracking_checks enable row level security;
drop policy if exists "staff read tracking checks" on public.tracking_checks;
create policy "staff read tracking checks" on public.tracking_checks for select to authenticated
  using ((select private.staff_sees_all()) or client_id = any ((select private.staff_client_ids())::uuid[]));
grant select on public.tracking_checks to authenticated;
