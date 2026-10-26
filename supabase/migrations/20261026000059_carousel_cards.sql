-- Carousel tickets: each card's own headline and description, on the copy set
alter table public.copy_sets add column if not exists cards jsonb not null default '{}'::jsonb;
comment on column public.copy_sets.cards is 'Carousel tickets: each design''s cards in order, {designId: [{headline, description}]}';
