-- A white-label partner's pitcher shows under "Prepared by" on the GTM cover (Leann for ZenChange), with an optional
-- title; the delivery contact (contact) stays for the notes and follow-up
alter table public.sales_partners add column if not exists pitcher_title text;
