-- The Sales agent, phase 1 (Nov 24 2026): internal only, for the executives and the leads. A role agent in the
-- "Strategy and whole team" line with five skills, and a light Prospects pipeline so research and drafts are kept.
--   sales_research     researches one business from its site and the open web into a prospect brief and a Kaizen
--                      sales strategy (services from the rate card, the angle, proof from similar Kaizen clients)
--   sales_list         finds businesses matching a profile (industry, area, size signals) from public web sources,
--                      scored by fit
--   sales_pitch        call script, email and LinkedIn message drafts in Kaizen's voice (sent by the person themselves)
--   sales_call_review  reviews a sales call from a transcript or recording: what went well, objections, next steps,
--                      the proposal to send
--   sales_desk         answers sales questions in chat and on calls; proposals and SOWs go to the document system
-- LinkedIn: research and drafts only; nothing browses, scrapes, connects or sends on LinkedIn (its terms forbid it).
-- Only execs train it (src/lib/agent-access.ts); only execs and leads see it, talk to it and see prospects.

insert into public.ai_roles (key, label, description, icon, core, sort_order)
select 'sales', 'Sales',
  'Kaizen''s sales strategist, for the executives and leads: researches a business from its site and the open web, builds prospect lists scored by fit, drafts call scripts, emails and LinkedIn messages, reviews sales calls, and hands the proposal to the document system.',
  'target',
  'You are Kaizen''s Sales agent: a senior agency sales strategist working for Kaizen''s executives and leads. You find and qualify businesses Kaizen can grow, research them before anyone reaches out, and write the outreach and the follow-up so the person only has to send it.
How you work:
- Research before you pitch. Read the business''s own site first (what they sell, offers, locations, booking or checkout, email capture), then the open web: Google reviews and ratings, their social profiles and how active they are, and whether they run ads (the Meta Ad Library at facebook.com/ads/library and the Google Ads Transparency Center at adstransparency.google.com are public). Say what you saw and where; never invent a number, review or fact. When something can''t be seen, say so.
- Fit first. A good prospect has a real offer, demand Kaizen can buy, enough margin or ticket size for paid media to pay back, and visible gaps we fix. Say plainly when a business is a poor fit and why.
- Sell what Kaizen sells. Services and starting prices come only from Kaizen''s rate card (rate_card); never quote anything else. Match services to the gaps you found: no ads running is paid ads (Meta, Google), weak creative is the creative package, no email capture or flows is email, a quiet feed is organic social, broken tracking is tracking.
- Proof from our own work. Similar Kaizen clients in the same industry are proof for internal use only: describe results by industry and structure ("a med spa we run Meta for"), never by client name in anything a prospect sees.
- The angle is about their business, not about Kaizen: the revenue they''re leaving on the table and the fastest win.
- Drafts sound like a person at Kaizen: short, specific to the business, one clear ask, no hype, no fake familiarity. LinkedIn: drafts only, sent by the person themselves; never suggest automating LinkedIn.
- Proposals and SOWs are made by the document system (make_document with the prospect''s name); prices from the rate card.
- Save the work on the prospect (save_prospect) so the team sees it in Sales › Prospects. Use Kaizen''s roles, never team members'' names.',
  13
where not exists (select 1 from public.ai_roles where key = 'sales');

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select x.key, x.label, x.description, x.model, x.effort, true, x.sort_order, '{}'::jsonb, 'sales', x.instructions
from (values
  ('sales_research', 'Prospect research',
   'Researches one business from its website and the open web (reviews, social profiles, the Meta Ad Library and Google Ads Transparency Center) into a prospect brief: what they sell, locations, positioning, visible marketing, likely gaps, and a Kaizen sales strategy with the services that fit (from the rate card), the angle, proof from similar Kaizen clients and first-outreach talking points.',
   'sonnet', 'medium', 130,
   'Facts with where you saw them. Gaps are things Kaizen fixes. Services only from the rate card. Proof by industry, never by client name for anything external.'),
  ('sales_list', 'Prospect list',
   'Finds businesses that match a profile (industry, area, size signals, e.g. "med spas in Tampa running no ads") from public web sources, each with its site, location and the signals seen, scored 0 to 100 by fit.',
   'sonnet', 'medium', 131,
   'Real businesses only, with their own website. Score on fit (offer, ticket size, demand, visible gaps Kaizen fixes), not size alone. Say the signal behind each score.'),
  ('sales_pitch', 'Pitch drafts',
   'Drafts first outreach in Kaizen''s voice for one prospect: a call script (opener, two questions, the angle, the ask, objection answers), an email, and a LinkedIn connection note and message to send by hand.',
   'sonnet', 'medium', 132,
   'Short, specific to their business, one ask. Email under 120 words. LinkedIn note under 280 characters. No hype, no fake familiarity.'),
  ('sales_call_review', 'Sales call review',
   'Reviews a sales call from its transcript (pasted, a Google Doc, or a recording''s transcript): what went well, what to do better, objections and how to answer them, the next steps with owners, and the proposal to send.',
   'sonnet', 'medium', 133,
   'Quote the moments that matter. Objections with a better answer for next time. Next steps concrete and dated where said. The proposal: services and tiers from the rate card.'),
  ('sales_desk', 'Sales desk',
   'Answers sales questions in chat and on calls: who to target, how to position Kaizen, pricing from the rate card, objection handling, and next steps on a prospect.',
   'sonnet', 'medium', 134,
   'Practical and short. Use the prospect''s saved research when there is one.')
) as x(key, label, description, model, effort, sort_order, instructions)
where not exists (select 1 from public.ai_agents a where a.key = x.key);

-- ─── Prospects ──────────────────────────────────────────────────────────────
create table if not exists public.prospects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  website      text,
  industry     text,
  location     text,
  contacts     jsonb not null default '[]'::jsonb,
  fit_score    integer check (fit_score between 0 and 100),
  fit_reason   text,
  brief        jsonb,
  status       text not null default 'new' check (status in ('new', 'researched', 'contacted', 'talking', 'proposal', 'won', 'lost')),
  owner_id     uuid references public.profiles (id) on delete set null,
  source       text,
  notes        text,
  lost_reason  text,
  client_id    uuid references public.clients (id) on delete set null,
  won_at       timestamptz,
  researched_at timestamptz,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists prospects_status on public.prospects (status, updated_at desc);
create index if not exists prospects_owner on public.prospects (owner_id, updated_at desc);
create unique index if not exists prospects_site on public.prospects (lower(website)) where website is not null;

-- Drafts and reviews kept on a prospect: pitch drafts (call script, email, LinkedIn), call reviews and notes
create table if not exists public.prospect_notes (
  id           uuid primary key default gen_random_uuid(),
  prospect_id  uuid not null references public.prospects (id) on delete cascade,
  kind         text not null check (kind in ('pitch', 'call_review', 'note', 'research')),
  title        text,
  body         jsonb not null default '{}'::jsonb,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists prospect_notes_prospect on public.prospect_notes (prospect_id, created_at desc);

alter table public.prospects enable row level security;
alter table public.prospect_notes enable row level security;
drop policy if exists "execs and leads work prospects" on public.prospects;
create policy "execs and leads work prospects" on public.prospects for all to authenticated
  using ((select private.is_exec_or_lead())) with check ((select private.is_exec_or_lead()));
drop policy if exists "execs and leads work prospect notes" on public.prospect_notes;
create policy "execs and leads work prospect notes" on public.prospect_notes for all to authenticated
  using ((select private.is_exec_or_lead())) with check ((select private.is_exec_or_lead()));
grant select, insert, update, delete on public.prospects, public.prospect_notes to authenticated;
