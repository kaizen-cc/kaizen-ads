-- The metrics a buyer chose for a report (tiles, key metrics rows, campaign columns and lines), and on its KPI the
-- client's layout, which the next report starts from
alter table reports add column if not exists layout jsonb;
alter table kpi_targets add column if not exists report_layout jsonb;
