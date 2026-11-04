-- The Brand Bible's review bank, collected for real before the write (the store's review app, Trustpilot, Google,
-- comments on the client's Facebook and Instagram posts and ads), kept with what each source gave and why not
alter table public.client_brand_bibles add column if not exists review_bank jsonb;

comment on column public.client_brand_bibles.review_bank is
  'The collected review bank: {collectedAt, read, sources:[{source,found,note}], picks:[...], critical:[...], status: collecting|ready|failed, error?}';

-- The skill text: mission, vision and values are drafted from the client''s own words when they have no formal ones
-- (labelled and confirmed with the client), the cover''s targets are data, and 4b is built on the collected bank
update public.ai_knowledge
set body = replace(
  replace(
    replace(
      body,
      'their mission and vision in their own words (never written for them)',
      'their mission, vision and core values in their own words; when they have no formal statement, drafted from their own words (site, intake, calls, posts), labelled "Drafted from their words — confirm", with a [business] open question asking the client to confirm them'
    ),
    'mission, vision and core values in their words (or "none on record")',
    'mission, vision and core values in their words (or drafted from their words and labelled "Drafted from their words — confirm")'
  ),
  'Say which sources couldn''t be read (e.g. Google reviews) so the team can pull them. It grows on every update.',
  'Built on the collected bank (review_bank_collected: the store''s review app, Trustpilot, Google, comments on their Facebook and Instagram posts and ads), word for word, first name and initial only; 15 to 25 best picks plus 3 to 5 critical ones, each tagged with its profile and angle. Sources and counts says what each source gave and, when nothing, why (no app found, needs a key, Page not shared). It grows on every update and can be refreshed on its own.'
)
where id = 'c68469f0-5799-4a39-aed6-134ee1c7f1ff';
