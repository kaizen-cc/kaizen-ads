-- Manual results on a report: bookings, sales and other results that live only in the client's CRM (GoHighLevel, say)
-- and never reach Meta or Google, entered by the team for the report's period. Kept on the report row so a regenerate
-- keeps them; who entered them and when are inside (by, by_name, at). Same protection as the report's other columns:
-- staff read through the existing "staff read reports" policy, and writes go through the app's server actions, which
-- check the person may work on the report. Shape: { lines: [{ id, label, count, revenue, priorCount, priorRevenue,
-- source, note, main }], start, end, by, byName, at }.
alter table public.reports add column if not exists manual_results jsonb;
