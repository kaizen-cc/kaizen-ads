-- Client supplies the content (Head of Email, Nov 2026): some clients' own team provides the weekly campaigns'
-- images, copy and CTA links in a Google Sheet. Their requests skip the strategy, brief and copy steps: link the sheet,
-- a note, and the request goes straight to the designer (Ready for Design), still counting against the allotment and
-- running through the board. A per-client setting any email lead can switch on; on to start for two clients.
alter table public.clients add column if not exists email_supplies_content boolean not null default false;
alter table public.clients add column if not exists email_supplies_sheet text;
update public.clients set email_supplies_content = true where id in ('a41c4310-ace7-4276-96bb-b728580d73d5', '15b14f45-f8a6-4cde-aede-e935c661733e');
