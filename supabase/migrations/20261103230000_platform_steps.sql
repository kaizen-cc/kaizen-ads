-- The setup guide's access beyond Meta and Google Ads: how they sell (online orders, a location), the Google tools
-- (Analytics, Tag Manager, Business Profile, Merchant Center), their website, their email platform, and where their
-- orders, bookings or leads live (POS, booking software, CRM, call tracking) for the tracking team
alter table public.client_onboarding
  add column if not exists business jsonb not null default '{}'::jsonb,
  add column if not exists ga4 jsonb not null default '{}'::jsonb,
  add column if not exists gtm jsonb not null default '{}'::jsonb,
  add column if not exists gbp jsonb not null default '{}'::jsonb,
  add column if not exists merchant jsonb not null default '{}'::jsonb,
  add column if not exists website jsonb not null default '{}'::jsonb,
  add column if not exists email jsonb not null default '{}'::jsonb,
  add column if not exists tracking jsonb not null default '{}'::jsonb;

-- The addresses clients add: our tech inbox everywhere, and the Klaviyo one on Klaviyo
update public.app_settings
   set value = coalesce(value, '{}'::jsonb) || jsonb_build_object('techEmail', 'tech@kaizenmarketing.agency', 'klaviyoEmail', 'santi@kaizenmarketing.agency')
 where key = 'onboarding_access';
