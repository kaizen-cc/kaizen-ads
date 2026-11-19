-- A creative lead's client rows hold this week's healthy share of the allotment as drafted briefs, ready to approve
-- (owner, Nov 19 2026: "the suggested briefs are ALREADY loaded for them"). A client may now have several pacing
-- drafts open at once, up to the week's share (src/lib/brief-drafting-core.ts catchUpWeek); each still has its own
-- trigger key (pacing:<cycle>:<pool>:w<week>:<n>), so nothing is drafted twice.
drop index if exists public.creative_suggestions_one_pacing_draft;
