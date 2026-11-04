-- The creative billing day's history: every change, by hand (an exec, with a note) or from Stripe / Kaizen Track
alter table public.clients add column if not exists billing_day_set_by uuid references public.profiles(id) on delete set null;
alter table public.clients add column if not exists billing_day_note text;

create table if not exists public.client_billing_day_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  old_day smallint,
  new_day smallint,
  source text,
  changed_by uuid references public.profiles(id) on delete set null,
  note text,
  at timestamptz not null default now()
);
create index if not exists client_billing_day_log_client on public.client_billing_day_log (client_id, at desc);
alter table public.client_billing_day_log enable row level security;
drop policy if exists "staff read billing day log" on public.client_billing_day_log;
create policy "staff read billing day log" on public.client_billing_day_log for select to authenticated using (private.is_staff());

create or replace function public.log_billing_day() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.billing_day is distinct from old.billing_day or new.billing_day_source is distinct from old.billing_day_source then
    insert into public.client_billing_day_log (client_id, old_day, new_day, source, changed_by, note)
    values (new.id, old.billing_day, new.billing_day, new.billing_day_source,
      case when new.billing_day_source = 'set' then new.billing_day_set_by end,
      case when new.billing_day_source = 'set' then new.billing_day_note end);
  end if;
  return new;
end $$;
drop trigger if exists clients_billing_day_log on public.clients;
create trigger clients_billing_day_log after update of billing_day, billing_day_source on public.clients for each row execute function public.log_billing_day();
