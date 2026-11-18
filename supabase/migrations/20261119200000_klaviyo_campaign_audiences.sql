-- Who each campaign was sent to and who it left out, for the email report and the client page. The older text[] column
-- `audiences` (names of the included lists and segments) stays as it is; this one holds both sides with ids and types:
--   { "included": [{ "id": "...", "name": "...", "type": "list" | "segment" }], "excluded": [ same ] }
-- Written by the Klaviyo sync (names resolved from the account's lists and segments); campaigns sent before this
-- migration are filled on the next full read. Null means "not read yet", not "sent to nobody".
alter table public.klaviyo_campaigns add column if not exists audiences_detail jsonb;
