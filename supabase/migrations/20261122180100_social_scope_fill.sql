-- Each organic social client's scope, from the account overview sheet (Kaizen Account Overview - Organic Social, its
-- "Scope of Work" column, Nov 19 2026). The sheet gives posts a month (some split into images and videos, one with
-- stories) and no prices, so every client is on Custom numbers with exactly what the sheet says; a pool the sheet doesn't
-- split is left without a cap. Images count as statics (carousels too), videos as video/reels. Platforms are left to the
-- tier's own (Facebook and Instagram) except where the sheet names them. Only clients with no social tier yet are
-- touched; archived clients (Abby, Hanson of Sonoma) and rows with no scope are left for the owner.

with scope(slug, custom, platforms) as (
  values
    ('mama-bettys',            '{"posts":12,"posts_min":12,"statics":6,"statics_min":6,"videos":6,"videos_min":6}'::jsonb, null::text[]),
    ('tejas-beer',             '{"posts":10,"posts_min":10}'::jsonb, null),
    ('tejas-brewery',          '{"posts":12,"posts_min":12,"statics":10,"statics_min":10,"videos":2,"videos_min":2}'::jsonb, null),
    ('giant-texas',            '{"posts":10,"posts_min":10}'::jsonb, null),
    ('aldecoa-coffee',         '{"posts":12,"posts_min":12}'::jsonb, null),
    ('cappio-cold-brew',       '{"posts":8,"posts_min":8}'::jsonb, null),
    ('cafe-diario',            '{"posts":8,"posts_min":8}'::jsonb, null),
    ('green-leaf-pro',         '{"posts":8,"posts_min":8,"stories":2,"stories_min":2}'::jsonb, array['facebook','instagram','linkedin']),
    ('ep-window-films',        '{"posts":4,"posts_min":4}'::jsonb, null),
    ('socal-window-coverings', '{"posts":8,"posts_min":8,"statics":6,"statics_min":6,"videos":2,"videos_min":2}'::jsonb, null),
    ('nulife-institute',       '{"posts":12,"posts_min":12,"statics":10,"statics_min":10,"videos":2,"videos_min":2}'::jsonb, null),
    ('1320-motorsports',       '{"posts":12,"posts_min":12,"statics":10,"statics_min":10,"videos":2,"videos_min":2}'::jsonb, null),
    ('mcintyres',              '{"posts":48,"posts_min":48,"statics":32,"statics_min":32,"videos":16,"videos_min":16,"stories":80,"stories_min":80}'::jsonb, null),
    ('holland-law-group',      '{"posts":12,"posts_min":12}'::jsonb, null),
    ('michelle-behre',         '{"posts":12,"posts_min":12}'::jsonb, null),
    ('darling-psychology',     '{"posts":4,"posts_min":4}'::jsonb, null),
    ('lice-treatment-center',  '{"posts":12,"posts_min":12,"statics":10,"statics_min":10,"videos":2,"videos_min":2}'::jsonb, null)
)
update public.clients c
set social_package_key = 'custom',
    social_custom = s.custom,
    social_platforms = coalesce(s.platforms, c.social_platforms),
    social_package_set_at = now()
from scope s
where c.slug = s.slug
  and c.archived_at is null
  and c.social_package_key is null;
