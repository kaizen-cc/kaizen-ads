-- The creative team's calmer Overview (Nov 20 2026): a list view each person switches on (kept on their profile so it
-- follows them to every device), and "Snooze to tomorrow" on any Overview or Today item (it hides until that day, then
-- comes back on its own).
alter table public.profiles add column if not exists overview_layout text not null default 'cards';
alter table public.profiles drop constraint if exists profiles_overview_layout_check;
alter table public.profiles add constraint profiles_overview_layout_check check (overview_layout in ('cards', 'list'));

alter table public.daily_items add column if not exists snoozed_until date;
comment on column public.daily_items.snoozed_until is 'Snoozed: hidden from this person''s Overview and recap until this New York day';
