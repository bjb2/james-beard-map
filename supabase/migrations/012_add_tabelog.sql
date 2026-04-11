-- Add Tabelog Award support to the restaurants table
-- and update the award summary view to include Tabelog priority

-- 1. New column for Tabelog restaurant URL
alter table public.restaurants
  add column if not exists tabelog_url text;

-- 2. Drop and recreate the summary view to include Tabelog awards
drop view if exists public.restaurants_with_summary;

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
        when a.source = 'tabelog' and a.award_type = 'Gold'            then 'Tabelog Gold'
        when a.source = 'tabelog' and a.award_type = 'Silver'          then 'Tabelog Silver'
        when a.source = 'tabelog' and a.award_type = 'Bronze'          then 'Tabelog Bronze'
        when a.source = 'michelin' and a.award_type = 'Selected'       then 'Michelin Selected'
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
        when a.source = 'tabelog' and a.award_type = 'Gold'          then 5
        when a.source = 'tabelog' and a.award_type = 'Silver'        then 6
        when a.source = 'tabelog' and a.award_type = 'Bronze'        then 7
        when a.source = 'michelin' and a.award_type = 'Selected'     then 8
        when a.source = 'jbf'     and a.award_type = 'Nominee'       then 9
        when a.source = 'jbf'     and a.award_type = 'Semifinalist'  then 10
        else 99
      end
    limit 1
  ) as award_summary,
  array_agg(distinct a.source) filter (where a.source is not null) as award_sources
from public.restaurants r
left join public.restaurant_awards a on a.restaurant_key = r.key
group by r.key;
