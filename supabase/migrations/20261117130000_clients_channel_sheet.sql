-- Who the Account Overview sheet's Email and Organic Social tabs name on each client (as written there), so the boards
-- can show the strategist, designer and builder even before they're in the app; seats follow once they join
alter table public.clients add column if not exists channel_sheet jsonb not null default '{}';
comment on column public.clients.channel_sheet is 'The Account Overview sheet''s Email and Organic Social people per client: { email: [{ seat, names }], social: [...] }, as written in the sheet';
