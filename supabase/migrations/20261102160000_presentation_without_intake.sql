-- A client who hasn't sent their intake form 4 business days in still gets their Bible and presentation, built from
-- everything before (calls, emails, their website, our research), and told so
alter table client_presentations add column if not exists without_intake boolean not null default false;
