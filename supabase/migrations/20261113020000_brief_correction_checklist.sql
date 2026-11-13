-- Accountable revisions (the lead strategist's feedback, Nov 13 2026: corrections applied some changes and silently
-- skipped others, so no version could be trusted without re-checking everything). Each correction in the revise chat
-- now keeps its change log: every change the message asked for, done (and where) or not done (and why), checked
-- against what the patch actually changed. "What changed in this version" under the brief reads it, with the
-- field-by-field diff from before/after.

alter table public.brief_corrections add column if not exists checklist jsonb not null default '[]';

comment on column public.brief_corrections.checklist is 'A correction''s change log: [{ask, done, where, why}], one per change the message asked for, reconciled with the patch actually applied (src/lib/brief-patch.ts changeLog)';
