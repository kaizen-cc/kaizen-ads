-- Light or dark: each person's choice (System follows the device), kept on their profile so it follows them across devices.
alter table public.profiles add column if not exists theme text check (theme in ('system', 'dark', 'light'));
