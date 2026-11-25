-- Who a go-to-market strategy is branded for (owner, Nov 25 2026). Each prospect says whether it's a direct Kaizen deal or a
-- white-label pitch for a partner agency; the GTM, its notes and the proposal all follow it. The agent asks once when the
-- record doesn't already say (a partner set on it, or the partner credited on the prospect's site). Partners keep a
-- brand kit (logo, colors, fonts, the "Prepared by" name and contact) used every time; Kaizen's own documents say who
-- prepared them (app_settings.sales_brand).

alter table public.prospects add column if not exists relationship text check (relationship in ('direct', 'white_label'));
alter table public.prospects add column if not exists partner_key text references public.sales_partners (key) on delete set null;

alter table public.sales_partners add column if not exists contact jsonb;
alter table public.sales_partners add column if not exists pitcher text;
alter table public.sales_partners add column if not exists website text;
alter table public.sales_partners add column if not exists kit_confirmed_at timestamptz;

update public.sales_partners set contact = coalesce(contact, '{"name": "Diane", "role": "Partner contact"}'::jsonb), pitcher = coalesce(pitcher, 'Leann'), website = coalesce(website, 'https://zenchange.com') where key = 'zenchange';

insert into public.app_settings (key, value) values ('sales_brand', '{"sender_name": "Kyle Barry", "sender_title": "CEO & Founder", "tagline": "The 1% Agency"}'::jsonb)
on conflict (key) do nothing;
