-- Add cuisine_category to restaurants table
-- Populated by normalize-cuisine.js + enrich-types.js pipeline

alter table public.restaurants
  add column if not exists cuisine_category text;

create index if not exists restaurants_cuisine_category_idx
  on public.restaurants (cuisine_category);
