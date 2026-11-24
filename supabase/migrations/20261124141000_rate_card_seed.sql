-- Kaizen's rate card, seeded from the owner's pricing deck (Kaizen Pricing Packages 2026, sent Nov 24 2026). The deck
-- is canon; prices in older proposals were relationship pricing. Amounts are each package's base fee; a "+" floor,
-- ad-spend minimums, commitments and the "or 15% of ad spend, whichever is greater" rule are kept in the note.
-- Runs once: only when the rate card is still empty.

insert into public.rate_card (service, tier, label, cadence, amount, note, sort_order)
select * from (values
  -- Paid ads
  ('meta', null, 'Meta advertising package (Facebook + Instagram)', 'month', 1000, '$1,000/mo or 15% of ad spend, whichever is greater, plus ad spend. Minimum ad spend $500. 90 days, then month to month. Tracking, audience targeting, A/B testing, bad-spend removal, multi-step retargeting, weekly reporting in Slack, 100% ownership.', 10),
  ('google', null, 'Google advertising package (Search, YouTube, Business Profile, Shopping)', 'month', 1000, '$1,000/mo or 15% of ad spend, whichever is greater, plus ad spend. Minimum ad spend $1,000. 90 days, then month to month. Tracking, keyword and competitive research, budget projections, A/B testing, Merchant Center for Shopping, 100% ownership.', 20),
  ('paid_ads', 'Meta & Google', 'Meta + Google advertising package (Search, YouTube, Facebook + Instagram)', 'month', 1750, '$1,750/mo or 15% of ad spend, whichever is greater, plus ad spend. Minimum ad spend $1,500. 90 days, then month to month.', 30),
  ('full_stack', null, 'Full Stack Marketing package (Google, Meta and YouTube ads, SEO, email)', 'month', 6500, '$6,500/mo or 15% of ad spend, whichever is greater, plus ad spend. 90 days, then month to month. Email: up to 3 automated flows and up to 5 emails.', 40),
  ('full_stack', null, 'Full Stack Marketing setup fee', 'one_time', 1500, null, 41),
  -- Organic social
  ('social', 'Basic', 'Social media management: Basic', 'month', 600, 'Facebook and Instagram, 12 posts a month (12 static graphics), bi-weekly reports, monthly calendar. Minimum 2 months.', 50),
  ('social', 'Silver', 'Social media management: Silver', 'month', 1000, 'Facebook and Instagram, 16 posts (10 statics, 2 reels, 4 stories), bi-weekly reports, monthly calendar, paid promotions, reach 5,000+ a month. Minimum 2 months.', 51),
  ('social', 'Gold', 'Social media management: Gold', 'month', 1500, 'Facebook, Instagram, TikTok, 22 posts (10 statics, 4 reels, 8 stories), paid promotions, real-time tracking, reach 10,000+ a month; more spend can be added. Minimum 3 months.', 52),
  ('social', 'Platinum', 'Social media management: Platinum', 'month', 2250, 'Plus ad spend (minimum $1,000). 4 platforms, 30 posts (12 statics, 6 reels, 12 stories), weekly reports, A/B testing, direct ads, CPA and ROAS. Minimum 3 months.', 53),
  ('social', 'Platinum', 'Social media management: Platinum setup fee', 'one_time', 1500, null, 54),
  ('social', null, 'Added video or reel (each)', 'month', 150, 'Add-on to a social package.', 55),
  ('social', null, 'Additional social platform (each)', 'month', 150, 'Add-on to a social package.', 56),
  ('social', null, 'On-site photo and video shoot (from)', 'one_time', 500, '$500 to $2,000 per shoot depending on the shoot and travel.', 57),
  -- Creative
  ('creative', 'Basic', 'Content development: Basic', 'month', 500, '10 images and 3 videos a month.', 60),
  ('creative', 'Silver', 'Content development: Silver', 'month', 1000, '25 images and 5 videos a month.', 61),
  ('creative', 'Gold', 'Content development: Gold', 'month', 1500, '50 images and 10 videos a month.', 62),
  ('creative', null, 'Additional image (each)', 'one_time', 25, null, 63),
  ('creative', null, 'Additional video (each)', 'one_time', 75, null, 64),
  ('creative', null, 'On-site photo and video shoot (from)', 'one_time', 300, '$300 to $2,000 per shoot depending on the shoot and travel.', 65),
  -- Email (the same prices as the email packages)
  ('email', 'Setup', '3-Month Initial Setup & Launch', 'month', 1000, '$1,000/mo for the 3 months: month 1 foundation (3 core flows, up to 15 emails), month 2 expansion (2 flows, 3 campaigns, 2 SMS), month 3 ongoing. Then Basic, or a higher tier.', 70),
  ('email', 'Basic', 'Email marketing: Basic', 'month', 1000, '3 to 5 campaign emails, 3 to 5 flow emails, 2 SMS, 6 to 10 emails a month, up to 15 design hours.', 71),
  ('email', 'Silver', 'Email marketing: Silver', 'month', 1750, '7 to 10 campaign emails, 5 to 7 flow emails, 4 to 6 SMS, 10 to 15 emails a month, advanced A/B testing, up to 30 design hours.', 72),
  ('email', 'Gold', 'Email marketing: Gold', 'month', 2250, '15 to 20 campaign emails, 5 to 10 flow emails, 6 to 8 SMS, 20 to 30 emails a month, advanced segmentation and personalization, priority support, up to 55 design hours.', 73),
  ('email', null, 'One-off email campaign (each)', 'one_time', 100, null, 74),
  ('email', null, 'One-off SMS (each)', 'one_time', 75, null, 75),
  -- Websites
  ('web', 'Lead gen Basic', 'Lead generation website: Basic', 'one_time', 2500, 'WordPress, about 2 weeks.', 80),
  ('web', 'Lead gen Advanced', 'Lead generation website: Advanced (advanced animations)', 'one_time', 4000, 'WordPress, about 3 weeks.', 81),
  ('web', 'Lead gen Custom', 'Lead generation website: Fully custom', 'one_time', 6500, 'WordPress, about 1 month.', 82),
  ('web', null, 'SEO setup for a site migration', 'one_time', 1500, 'About 1 week, with any lead generation site.', 83),
  ('web', 'Ecommerce Basic', 'Ecommerce website: Basic (Shopify)', 'one_time', 5000, 'UX design in Shopify; home, about, contact, a collection page and one product page.', 84),
  ('web', 'Ecommerce Detailed', 'Ecommerce website: Detailed Shopify store', 'one_time', 8000, 'Everything in Basic plus product import (up to 25 SKUs).', 85),
  ('web', 'Ecommerce Full Arsenal', 'Ecommerce website: Full Arsenal Shopify (from)', 'one_time', 10000, '$10,000+. Up to 150 SKUs, fulfillment and custom app backend (ShipStation, Recharge).', 86),
  ('web', 'Basic', 'Website maintenance: Basic', 'month', 750, 'Security updates and backups, speed, up to 5 content edits a month, 48-hour response, basic SEO support.', 87),
  ('web', 'Growth', 'Website management: Growth', 'month', 1000, 'Everything in Basic, up to 15 edits a month, minor design changes, heatmaps, basic A/B testing, 24-hour response.', 88),
  ('web', 'Performance', 'Website optimization: Performance', 'month', 1500, 'Everything in Growth, up to 30 edits, CRO, A/B testing, user recordings, funnel optimization, 12-hour response, up to 5 dev hours a month.', 89),
  -- CRM (GoHighLevel)
  ('crm', 'Optimization', 'GoHighLevel optimization', 'one_time', 2500, 'Audit and refinement of an existing GoHighLevel setup. Includes documentation, SOPs and 14 days of post-launch support.', 90),
  ('crm', 'Basic build', 'GoHighLevel build: Basic', 'one_time', 4000, '1 pipeline, up to 3 workflows, 1 lead source, welcome sequences, basic dashboards, video training.', 91),
  ('crm', 'Advanced build', 'GoHighLevel build: Advanced', 'one_time', 6000, 'Up to 2 pipelines, 10 workflows, 3 lead sources, custom API to ad platforms, attribution, lead scoring, 60-minute training.', 92),
  ('crm', 'Custom build', 'GoHighLevel build: Custom (from)', 'one_time', 8000, '$8,000+. Multiple pipelines, up to 5 lead sources, webhooks, white label, 120+ minutes of training, 30 days white-glove support.', 93),
  ('crm', 'Essential', 'GoHighLevel management: Essential', 'month', 750, 'Monthly health check, up to 2 workflow changes, pipeline monitoring, list hygiene, monthly snapshot.', 94),
  ('crm', 'Growth', 'GoHighLevel management: Growth', 'month', 1200, 'Everything in Essential, up to 5 changes, 1 new workflow a month, A/B testing, integration monitoring, custom dashboard.', 95),
  ('crm', 'Performance', 'GoHighLevel management: Performance', 'month', 2000, 'Unlimited workflow changes, up to 3 new workflows a month, landing pages with A/B testing, multi-pipeline, lead scoring, quarterly audit.', 96),
  -- A la carte
  ('a_la_carte', null, 'Additional monthly graphics (2 to 3)', 'month', 750, null, 100),
  ('a_la_carte', null, 'TikTok advertising', 'month', 1000, 'Asset creation, campaign building and optimization on TikTok.', 101),
  ('a_la_carte', null, 'Google Ads local campaigns (Business Profile, Maps)', 'month', 500, null, 102),
  ('a_la_carte', null, 'Full Google campaign (keywords, Maps, YouTube retargeting)', 'month', 1000, null, 103),
  ('a_la_carte', null, 'Email marketing (automated newsletter journey)', 'one_time', 1500, 'A whole customer journey automated when someone signs up to the newsletter.', 104),
  ('a_la_carte', null, 'Each additional social media platform', 'month', 750, null, 105)
) as v(service, tier, label, cadence, amount, note, sort_order)
where not exists (select 1 from public.rate_card);
