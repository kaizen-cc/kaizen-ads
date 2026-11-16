-- Exports the team uploads on a report (a CSV from Meta Ads Manager or Google Ads), for ad accounts Kaizen Ads can't read
-- itself (Meta answering "(#200) Ad account owner has NOT grant ads_management or ads_read permission"). The report's
-- numbers are then built from the file. Every upload is kept, oldest first, and never removed (client data is never
-- deleted); the newest one covering the report's dates is the one used. Same protection as the report's other columns:
-- staff read through the existing "staff read reports" policy, and writes go through the app's server actions, which
-- check the person may work on the report. Shape: [{ id, name, platform, level, daily, start, end, currency, rows:
-- [{ date, start, end, campaign, campaignId, adset, ad, adId, resultType, n: { spend, impressions, ... } }], headers,
-- datesAssumed, mappedByAi, by, byName, at }].
alter table public.reports add column if not exists uploaded_data jsonb not null default '[]'::jsonb;
