-- Brand guidelines clients share (Drive, Slack, email, calls, the intake form) are read hourly and proposed into their
-- Brand Bible as a change the Head of Creative approves before it goes live (src/lib/brand-guidelines.ts).
-- 1. A new kind of Bible change: the guidelines read (the section to write in is the answer; proposed holds
--    { fingerprint, gap }, so the same material isn't proposed twice and a Bible saying "not shared" is flagged).
alter table public.bible_changes drop constraint if exists bible_changes_kind_check;
alter table public.bible_changes add constraint bible_changes_kind_check
  check (kind in ('avatar_add', 'avatar_change', 'avatar_retire', 'question_answer', 'brand_guideline'));

-- 2. The hourly pass reads what came into the client context since its last run
create index if not exists context_items_created on public.context_items (created_at);
