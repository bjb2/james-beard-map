-- Normalize restaurants where state abbreviation is embedded in city field
-- e.g. city="San Antonio, TX", country="USA", state=null
--   → city="San Antonio", state="Texas", country=null, key updated
--
-- Also updates all dependent tables that reference restaurant_key as text.

do $$
declare
  r record;
  new_city    text;
  new_state   text;
  old_key     text;
  new_key     text;
  abbr        text;
begin
  for r in
    select key, name, city, state, country
    from public.restaurants
    where city ~ '^.+,\s*[A-Z]{2}$' and state is null
  loop
    -- Extract abbreviation from city
    abbr := upper(trim(substring(r.city from ',\s*([A-Z]{2})$')));
    new_city := trim(substring(r.city from '^(.+),\s*[A-Z]{2}$'));

    new_state := case abbr
      when 'AL' then 'Alabama'
      when 'AK' then 'Alaska'
      when 'AZ' then 'Arizona'
      when 'AR' then 'Arkansas'
      when 'CA' then 'California'
      when 'CO' then 'Colorado'
      when 'CT' then 'Connecticut'
      when 'DC' then 'District of Columbia'
      when 'DE' then 'Delaware'
      when 'FL' then 'Florida'
      when 'GA' then 'Georgia'
      when 'HI' then 'Hawaii'
      when 'ID' then 'Idaho'
      when 'IL' then 'Illinois'
      when 'IN' then 'Indiana'
      when 'IA' then 'Iowa'
      when 'KS' then 'Kansas'
      when 'KY' then 'Kentucky'
      when 'LA' then 'Louisiana'
      when 'ME' then 'Maine'
      when 'MD' then 'Maryland'
      when 'MA' then 'Massachusetts'
      when 'MI' then 'Michigan'
      when 'MN' then 'Minnesota'
      when 'MS' then 'Mississippi'
      when 'MO' then 'Missouri'
      when 'MT' then 'Montana'
      when 'NE' then 'Nebraska'
      when 'NV' then 'Nevada'
      when 'NH' then 'New Hampshire'
      when 'NJ' then 'New Jersey'
      when 'NM' then 'New Mexico'
      when 'NY' then 'New York'
      when 'NC' then 'North Carolina'
      when 'ND' then 'North Dakota'
      when 'OH' then 'Ohio'
      when 'OK' then 'Oklahoma'
      when 'OR' then 'Oregon'
      when 'PA' then 'Pennsylvania'
      when 'RI' then 'Rhode Island'
      when 'SC' then 'South Carolina'
      when 'SD' then 'South Dakota'
      when 'TN' then 'Tennessee'
      when 'TX' then 'Texas'
      when 'UT' then 'Utah'
      when 'VT' then 'Vermont'
      when 'VA' then 'Virginia'
      when 'WA' then 'Washington'
      when 'WV' then 'West Virginia'
      when 'WI' then 'Wisconsin'
      when 'WY' then 'Wyoming'
      else null
    end;

    -- Only proceed if we recognised the abbreviation
    if new_state is null then
      continue;
    end if;

    old_key := r.key;
    new_key := r.name || '|' || new_city || '|' || new_state;

    -- Skip if another restaurant already owns the target key (JBF entry exists)
    if exists (select 1 from public.restaurants where key = new_key) then
      -- Merge: move awards from old key to new key, then delete old row
      update public.restaurant_awards set restaurant_key = new_key where restaurant_key = old_key;
      update public.visits            set restaurant_key = new_key where restaurant_key = old_key;
      update public.list_items        set restaurant_key = new_key where restaurant_key = old_key;
      update public.dish_notes        set restaurant_key = new_key where restaurant_key = old_key;
      update public.tags              set restaurant_key = new_key where restaurant_key = old_key;
      delete from public.restaurants where key = old_key;
    else
      -- Rename: insert new row first (satisfies FK), update dependents, delete old row
      insert into public.restaurants (key, name, city, state, country, address, lat, lng,
        photo_url, cuisine_tags, cuisine_category, business_status, is_closed,
        website, phone, yelp_url, michelin_url, price, updated_at)
      select new_key, name, new_city, new_state, null, address, lat, lng,
        photo_url, cuisine_tags, cuisine_category, business_status, is_closed,
        website, phone, yelp_url, michelin_url, price, updated_at
      from public.restaurants where key = old_key;

      update public.restaurant_awards set restaurant_key = new_key where restaurant_key = old_key;
      update public.visits            set restaurant_key = new_key where restaurant_key = old_key;
      update public.list_items        set restaurant_key = new_key where restaurant_key = old_key;
      update public.dish_notes        set restaurant_key = new_key where restaurant_key = old_key;
      update public.tags              set restaurant_key = new_key where restaurant_key = old_key;

      delete from public.restaurants where key = old_key;
    end if;
  end loop;
end $$;
