-- The billing day can come from the client's Stripe subscription (as Kaizen Track syncs it)
alter table public.clients drop constraint if exists clients_billing_day_source_check;
alter table public.clients add constraint clients_billing_day_source_check check (billing_day_source in ('enrolled', 'track', 'stripe', 'set'));
