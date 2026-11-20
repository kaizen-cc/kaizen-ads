-- Safe Brand Bibles (Nov 20 2026): the makers read the Bible and suggest changes in their own words; a lead or the
-- Head of Creative approves, and the Bible's editor writes it in (src/lib/bible-governance.ts). The client-facing
-- notice about the Bible stays off unless app_settings.bible_client_notice is switched on (src/lib/presentation.ts).
alter table public.bible_changes drop constraint if exists bible_changes_kind_check;
alter table public.bible_changes add constraint bible_changes_kind_check check (kind in ('avatar_add', 'avatar_change', 'avatar_retire', 'question_answer', 'edit_suggestion'));
insert into public.app_settings (key, value) values ('bible_client_notice', '{"on": false}'::jsonb) on conflict (key) do nothing;
