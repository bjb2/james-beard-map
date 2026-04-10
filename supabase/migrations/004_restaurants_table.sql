-- ============================================================
-- Restaurants — canonical restaurant identity & display data
-- Accommodates multiple award sources (JBF, Michelin, etc.)
-- ============================================================

create table public.restaurants (
  key             text primary key,  -- "{name}|{city}|{state_or_country}"
  name            text not null,
  city            text,
  state           text,              -- US state name; null for international
  country         text,              -- null implies USA
  address         text,
  lat             numeric,
  lng             numeric,
  photo_url       text,              -- best available (Yelp or Google)
  cuisine_tags    text[],
  business_status text,              -- OPERATIONAL, CLOSED_PERMANENTLY, etc.
  is_closed       boolean default false,
  website         text,
  phone           text,
  yelp_url        text,
  michelin_url    text,
  price           text,              -- $, $$, $$$, $$$$
  updated_at      timestamptz default now()
);

-- ============================================================
-- Restaurant Awards — one row per nomination / recognition
-- source: 'jbf' | 'michelin' | (future sources)
-- ============================================================

create table public.restaurant_awards (
  id              uuid primary key default gen_random_uuid(),
  restaurant_key  text not null references public.restaurants(key) on delete cascade,
  source          text not null,    -- 'jbf', 'michelin', etc.
  award_type      text,             -- 'Winner', 'Nominee', 'Star', 'Bib Gourmand', 'Green Star', 'Recommended'
  award_detail    text,             -- JBF category ("Best New Restaurant"), Michelin tier detail ("Two Stars")
  year            int,              -- JBF year; null for Michelin (current)
  created_at      timestamptz default now()
);

-- ============================================================
-- View: best award summary per restaurant (for profile badges)
-- Priority: Michelin Star > JBF Winner > Michelin Bib/Recommended > JBF Nominee
-- ============================================================

create view public.restaurants_with_summary as
select
  r.*,
  (
    select
      case
        when a.source = 'michelin' and a.award_type = 'Star'           then 'Michelin Star'
        when a.source = 'michelin' and a.award_type = 'Green Star'     then 'Michelin Green Star'
        when a.source = 'michelin' and a.award_type = 'Bib Gourmand'   then 'Michelin Bib Gourmand'
        when a.source = 'jbf'     and a.award_type = 'Winner'          then 'JBF Winner'
        when a.source = 'michelin' and a.award_type = 'Selected'         then 'Michelin Selected'
        when a.source = 'jbf'     and a.award_type = 'Nominee'         then 'JBF Nominee'
        when a.source = 'jbf'     and a.award_type = 'Semifinalist'    then 'JBF Semifinalist'
        else a.source || ' ' || coalesce(a.award_type, '')
      end
    from public.restaurant_awards a
    where a.restaurant_key = r.key
    order by
      case
        when a.source = 'michelin' and a.award_type = 'Star'         then 1
        when a.source = 'michelin' and a.award_type = 'Green Star'   then 2
        when a.source = 'michelin' and a.award_type = 'Bib Gourmand' then 3
        when a.source = 'jbf'     and a.award_type = 'Winner'        then 4
        when a.source = 'michelin' and a.award_type = 'Selected'      then 5
        when a.source = 'jbf'     and a.award_type = 'Nominee'       then 6
        when a.source = 'jbf'     and a.award_type = 'Semifinalist'  then 7
        else 99
      end
    limit 1
  ) as award_summary,
  array_agg(distinct a.source) filter (where a.source is not null) as award_sources
from public.restaurants r
left join public.restaurant_awards a on a.restaurant_key = r.key
group by r.key;

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.restaurants        enable row level security;
alter table public.restaurant_awards  enable row level security;

-- Restaurants and awards are public read-only (managed by seed/admin)
create policy "restaurants_public_read"       on public.restaurants       for select using (true);
create policy "restaurant_awards_public_read" on public.restaurant_awards for select using (true);

-- ============================================================
-- Indexes
-- ============================================================

create index on public.restaurants (city);
create index on public.restaurants (state);
create index on public.restaurant_awards (restaurant_key);
create index on public.restaurant_awards (source);
create index on public.restaurant_awards (source, award_type);
