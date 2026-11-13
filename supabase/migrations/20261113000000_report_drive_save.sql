-- Where a report was saved in the client's Drive (the "Save to Drive" button in the report studio): the PDF with the
-- buyer's write-up as a last section, in <client folder> / 30 - Reports / year / month. Shape: { url, name, at, by,
-- byName }. Saving again makes a new version of the same Drive file, so the latest save is all that's kept here.
-- Same protection as the report's other columns: staff read through the existing "staff read reports" policy, and
-- writes go through the app's server action, which checks the person may work on the report.
alter table public.reports add column if not exists drive_save jsonb;
