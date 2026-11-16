-- The metric that counts as the sale for a Klaviyo account (Placed Order for a store, Bought Ticket for Eventbrite...):
-- picked by hand on the Klaviyo card, it's kept over the automatic Placed Order pick
alter table public.klaviyo_connections add column if not exists conversion_metric_name text;
alter table public.klaviyo_connections add column if not exists conversion_metric_manual boolean not null default false;
alter table public.klaviyo_connections add column if not exists conversion_metric_set_by uuid references public.profiles (id) on delete set null;
alter table public.klaviyo_connections add column if not exists conversion_metric_set_at timestamptz;
