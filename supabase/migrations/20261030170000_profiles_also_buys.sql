alter table public.profiles add column if not exists also_buys boolean not null default false;
comment on column public.profiles.also_buys is 'Someone whose own role is something else (an exec) who also buys media: offered as a Meta or Google buyer on clients and KPIs';
update public.profiles set also_buys = true where email = 'kyle@kaizenmarketing.agency';
