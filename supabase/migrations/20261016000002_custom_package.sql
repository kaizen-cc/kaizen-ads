-- "Custom": a client whose deliverables aren't one of the set packages. Their allotment holds the real counts
-- (read from the form's package text), and creative_package_note says what was agreed.
insert into public.creative_packages (key, label, images, videos, note, sort_order)
values ('custom', 'Custom', 0, 0, 'Deliverables agreed per client; the allotment holds the counts', 99)
on conflict (key) do nothing;
