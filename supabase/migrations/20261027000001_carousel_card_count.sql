-- Carousel tickets: how many cards each carousel has (set in the request form; the upload has a slot per card)
alter table public.requests add column if not exists cards int check (cards is null or cards between 2 and 10);
comment on column public.requests.cards is 'Carousel tickets: how many cards each carousel has';
