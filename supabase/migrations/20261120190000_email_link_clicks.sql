-- The engagement email report (clients whose revenue can't be read, such as Brevo with no store connected): each
-- campaign's total clicks (every click, not only each person once) and its clicks per link, so the report can show
-- what people clicked (the guest list, events, socials, directions). Filled by the Brevo sync; read by the channel
-- reports. Both nullable: a source that doesn't give them leaves them empty, and the report falls back to unique clicks.

alter table public.klaviyo_campaigns add column if not exists clicks_total integer;
alter table public.klaviyo_campaigns add column if not exists link_clicks jsonb;

comment on column public.klaviyo_campaigns.clicks_total is 'Every click on the campaign (Brevo globalStats.clickers); null when the source gives only unique clicks';
comment on column public.klaviyo_campaigns.link_clicks is 'Clicks per link, {"https://...": 12}, from the source''s link stats (Brevo linksStats); null when not read';
