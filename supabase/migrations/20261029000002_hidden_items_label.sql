-- What was cleared, so the log of hidden items can say it and link back
alter table public.hidden_items add column if not exists label text, add column if not exists href text;
