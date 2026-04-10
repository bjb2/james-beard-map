-- Add Texas Monthly as a recognized award source in restaurants_with_summary

drop view if exists public.restaurants_with_summary;

create view public.restaurants_with_summary as
select
  r.*,
  (
    select
      case
        when a.source = 'michelin'      and a.award_type = 'Star'           then 'Michelin Star'
        when a.source = 'michelin'      and a.award_type = 'Green Star'     then 'Michelin Green Star'
        when a.source = 'michelin'      and a.award_type = 'Bib Gourmand'   then 'Michelin Bib Gourmand'
        when a.source = 'jbf'           and a.award_type = 'Winner'         then 'JBF Winner'
        when a.source = 'texasmonthly'  and a.award_type = 'Top 50'         then 'Texas Monthly Top 50 BBQ'
        when a.source = 'michelin'      and a.award_type = 'Selected'       then 'Michelin Selected'
        when a.source = 'jbf'           and a.award_type = 'Nominee'        then 'JBF Nominee'
        when a.source = 'jbf'           and a.award_type = 'Semifinalist'   then 'JBF Semifinalist'
        else a.source || ' ' || coalesce(a.award_type, '')
      end
    from public.restaurant_awards a
    where a.restaurant_key = r.key
    order by
      case
        when a.source = 'michelin'      and a.award_type = 'Star'           then 1
        when a.source = 'michelin'      and a.award_type = 'Green Star'     then 2
        when a.source = 'michelin'      and a.award_type = 'Bib Gourmand'   then 3
        when a.source = 'jbf'           and a.award_type = 'Winner'         then 4
        when a.source = 'texasmonthly'  and a.award_type = 'Top 50'         then 5
        when a.source = 'michelin'      and a.award_type = 'Selected'       then 6
        when a.source = 'jbf'           and a.award_type = 'Nominee'        then 7
        when a.source = 'jbf'           and a.award_type = 'Semifinalist'   then 8
        else 99
      end
    limit 1
  ) as award_summary,
  array_agg(distinct a.source) filter (where a.source is not null) as award_sources
from public.restaurants r
left join public.restaurant_awards a on a.restaurant_key = r.key
group by r.key;
