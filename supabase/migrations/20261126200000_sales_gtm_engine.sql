-- The Sales agent's go-to-market engine (Nov 25 2026, from the CEO's "Proposal Builder" project and his Loom on what the
-- OS research was missing). Seeds what that project knew (docs/kyle-proposal-builder.md), in roles not names:
--   sales_case_studies  the four case studies with their exact numbers (never altered), the verticals each one fits,
--                       and its connection line
--   sales_partners      white-label partners (ZenChange): how their documents are branded and the rules (no Kaizen
--                       mention, ad spend only, internal notes rewritten for the partner)
--   skills              sales_gtm (the client-facing GTM PDF and the internal talking notes) and sales_proposal (the
--                       11-slide proposal rules); the Sales agent's core gains the pricing and proposal rules
--   prospect_gtms       each GTM made for a prospect: its content, internal notes, partner, the PDF (a kaizen_documents
--                       row of kind 'gtm', so it saves to Drive under the Drive rule), as a background job

create table if not exists public.sales_case_studies (
  key          text primary key,
  name         text not null,
  vertical     text not null,
  fits         text[] not null default '{}',
  services     text not null,
  results      text not null,
  connection   text not null,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  updated_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now()
);
alter table public.sales_case_studies enable row level security;
drop policy if exists "staff read case studies" on public.sales_case_studies;
create policy "staff read case studies" on public.sales_case_studies for select to authenticated using ((select private.is_staff()));
drop policy if exists "execs keep case studies" on public.sales_case_studies;
create policy "execs keep case studies" on public.sales_case_studies for all to authenticated using ((select private.is_exec())) with check ((select private.is_exec()));
grant select, insert, update on public.sales_case_studies to authenticated;

insert into public.sales_case_studies (key, name, vertical, fits, services, results, connection, sort_order) values
('gumbys', 'Gumby''s Pizza', 'Restaurant / local', array['restaurant', 'food', 'local', 'franchise', 'hospitality', 'retail'], 'Meta + Google + TikTok driving online ordering', '4.2x ROAS, 1,000+ store visits and 500+ net new customers in the first 60 days', 'Local businesses win on repeat visits: the same system that filled their ordering pipeline is built to fill yours.', 1),
('aldecoa', 'Aldecoa Coffee', 'Ecommerce / DTC', array['ecommerce', 'ecom', 'dtc', 'shopify', 'startup', 'consumer', 'product'], 'Meta + creative + email for a new direct-to-consumer brand', 'Went DTC in 2024 at about $10K; 2025 revenue $135,000+, CAC under $20, 3x ROAS across all of 2025', 'A brand starting from near zero online became a profitable direct channel inside a year.', 2),
('allamerican', 'All American Fence And Gate', 'Home services / trades (full stack)', array['home services', 'trades', 'contractor', 'construction', 'roofing', 'hvac', 'plumbing', 'fence', 'landscaping', 'pools', 'remodeling', 'full stack'], 'Full stack: web, CRM, content, Google, Meta and email', '$500K (2022) to $1.8M (2023) to $3.4M (2024) to $5.4M (2025), 10.8x growth at about 30% margins', 'When every channel works together, growth compounds year over year.', 3),
('marquee', 'Marquee Dental', 'Medical / professional services (high LTV)', array['dental', 'medical', 'med spa', 'healthcare', 'clinic', 'law', 'legal', 'accounting', 'cpa', 'finance', 'financial', 'insurance', 'professional services', 'high ltv'], 'Local search + Meta retargeting + landing-page CRO across 5 new locations', '21.1x ROAS and a scalable CPA across all 5 locations within 90 days', 'When the cost of a single new patient or client is high, precision matters: every dollar has to find someone ready to book.', 4)
on conflict (key) do nothing;

create table if not exists public.sales_partners (
  key           text primary key,
  name          text not null,
  prepared_by   text not null,
  brand         jsonb not null default '{}'::jsonb,
  rules         text not null default '',
  show_fees     boolean not null default false,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);
alter table public.sales_partners enable row level security;
drop policy if exists "staff read partners" on public.sales_partners;
create policy "staff read partners" on public.sales_partners for select to authenticated using ((select private.is_staff()));
drop policy if exists "execs keep partners" on public.sales_partners;
create policy "execs keep partners" on public.sales_partners for all to authenticated using ((select private.is_exec())) with check ((select private.is_exec()));
grant select, insert, update on public.sales_partners to authenticated;

insert into public.sales_partners (key, name, prepared_by, brand, rules, show_fees) values
('zenchange', 'ZenChange', 'ZenChange Marketing',
 '{"dark": "#0F1F2E", "accent": "#178F92", "accent_soft": "#E3F2F2", "highlight": "#5CCFD6", "ink": "#0F1F2E", "muted": "#5B6470"}'::jsonb,
 'White-label partner: it pitches Kaizen-built go-to-market strategies to its own clients. Documents say "Prepared by ZenChange Marketing" with zero Kaizen mentions anywhere (text, footers, file names). Ad spend only, no management fees, unless told otherwise. Deliverables go to the partner''s contact by email with the PDF attached, not Drive links. Internal notes are rewritten for the partner: marked "Internal · for ZenChange only · do not share with the client". If the partner built the prospect''s current website, criticism of the site is worded as pre-launch fixes and flagged in the notes so the partner decides.',
 false)
on conflict (key) do nothing;

-- The two new skills
insert into public.ai_agents (key, label, description, model, effort, live, sort_order, sources, role_key, instructions)
select x.key, x.label, x.description, x.model, x.effort, true, x.sort_order, '{}'::jsonb, 'sales', x.instructions
from (values
  ('sales_gtm', 'Go-to-market strategy',
   'Builds a prospect''s go-to-market strategy: the market (geo, income and demographics or the US-wide avatar, TAM), the competitors who advertise (Meta Ad Library, Google Ads Transparency Center: funnel, messaging, offer, USP), search demand and click costs, sourced benchmarks, positioning and the front-door offer, the channel plan, investment tiers with projections, the 90-day plan and 12-month calendar. A client-facing branded PDF (Kaizen, or a white-label partner) plus internal talking notes that are never sent.',
   'opus', 'high', 135,
   'Research first, market before message. Every number has a source or is tagged as an estimate. Benchmarks cite WordStream/LocaliQ (current year) and say when an adjacent industry stands in. Never name competitors in the client document. Internal notes tag every claim [certain], [likely] or [guessing, informed].'),
  ('sales_proposal', 'Proposal',
   'Writes the sales proposal (separate from the go-to-market strategy) in the CEO''s 11-slide structure: cover, mission and values, executive summary, methodology, platform playbook, benchmarks, case studies, onboarding and guardrails, investment, game plan, next steps. Plus proposal notes for the CEO (never sent).',
   'opus', 'medium', 136,
   'The 60/90-day minimum and the 30-day written notice to cancel always appear together. Case-study numbers exactly as stored. Only proposed services, exact prices from the pricing reference. No competitor names. Reference the meeting transcript at least three times when there is one.')
) as x(key, label, description, model, effort, sort_order, instructions)
where not exists (select 1 from public.ai_agents a where a.key = x.key);

create table if not exists public.prospect_gtms (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid not null references public.prospects (id) on delete cascade,
  profile_id    uuid not null references public.profiles (id) on delete cascade,
  partner_key   text references public.sales_partners (key) on delete set null,
  ask           text,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  stage         text,
  content       jsonb,
  notes         jsonb,
  document_id   uuid references public.kaizen_documents (id) on delete set null,
  error         text,
  attempts      integer not null default 0,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index if not exists prospect_gtms_prospect on public.prospect_gtms (prospect_id, created_at desc);
create index if not exists prospect_gtms_open on public.prospect_gtms (status, created_at) where status in ('queued', 'running');
alter table public.prospect_gtms enable row level security;
drop policy if exists "execs and leads read gtms" on public.prospect_gtms;
create policy "execs and leads read gtms" on public.prospect_gtms for select to authenticated using ((select private.is_exec_or_lead()));
grant select on public.prospect_gtms to authenticated;

alter table public.kaizen_documents drop constraint if exists kaizen_documents_kind_check;
alter table public.kaizen_documents add constraint kaizen_documents_kind_check check (kind in ('sow', 'proposal', 'handoff', 'one_pager', 'case_study', 'quote', 'doc', 'deck', 'gtm'));
