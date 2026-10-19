-- The Kaizen Account Overview sheet is the source of truth for each account's buyer, budget and KPI target while the
-- team moves over. It's read at 12pm and 5pm ET; what it says replaces those fields, and its notes (priority, the #1
-- problem and its solution, the latest buying, creative and copy updates) sit on the KPI for the card and the agents.
alter table public.kpi_targets
  add column sheet jsonb,
  add column sheet_synced_at timestamptz;

-- The sheet's Onboarding tab, per client: its checklist (welcome email, onboarding call, access, internal meeting,
-- intake form, content, tracking, campaigns live), progress and notes.
alter table public.clients add column onboarding_sheet jsonb;
