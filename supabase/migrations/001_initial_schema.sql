-- ============================================================
-- Delectable v2 — Initial Schema
-- ============================================================

-- Profiles (extends auth.users)
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique,
  display_name  text,
  avatar_url    text,
  bio           text,
  created_at    timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
-- Visits — "I've been here"
-- ============================================================
create table public.visits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete cascade not null,
  -- Restaurant identified by the stable key used in the frontend
  restaurant_key text not null,  -- "{restaurant}|{city}|{state||country}"
  visited_on    date,
  note          text,            -- optional freeform visit note
  created_at    timestamptz default now(),
  unique(user_id, restaurant_key)
);

-- ============================================================
-- Dish Notes — "What did you order?"
-- ============================================================
create table public.dish_notes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete cascade not null,
  restaurant_key text not null,
  dish_name     text not null,
  note          text,            -- optional context ("ask for the kitchen counter")
  upvotes       integer default 0,
  created_at    timestamptz default now()
);

-- Upvotes as a separate table to prevent double-voting
create table public.dish_note_votes (
  user_id       uuid references public.profiles(id) on delete cascade,
  dish_note_id  uuid references public.dish_notes(id) on delete cascade,
  primary key (user_id, dish_note_id)
);

-- ============================================================
-- Tags — community labels on restaurants
-- ============================================================
create table public.tags (
  id            uuid primary key default gen_random_uuid(),
  restaurant_key text not null,
  label         text not null,   -- e.g. "outdoor seating", "tasting menu only"
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz default now(),
  unique(restaurant_key, label)
);

create table public.tag_votes (
  user_id       uuid references public.profiles(id) on delete cascade,
  tag_id        uuid references public.tags(id) on delete cascade,
  primary key (user_id, tag_id)
);

-- ============================================================
-- Lists — "Want to go", "Visited", custom
-- ============================================================
create table public.lists (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete cascade not null,
  name          text not null,   -- "Want to Go", "Visited", or custom
  is_public     boolean default true,
  created_at    timestamptz default now()
);

create table public.list_items (
  id            uuid primary key default gen_random_uuid(),
  list_id       uuid references public.lists(id) on delete cascade not null,
  restaurant_key text not null,
  note          text,
  added_at      timestamptz default now(),
  unique(list_id, restaurant_key)
);


-- ============================================================
-- Convenience view: visit counts per restaurant (public)
-- ============================================================
create view public.visit_counts as
  select restaurant_key, count(*) as visit_count
  from public.visits
  group by restaurant_key;

-- Dish notes with vote counts
create view public.dish_notes_ranked as
  select
    d.*,
    coalesce(v.vote_count, 0) as vote_count
  from public.dish_notes d
  left join (
    select dish_note_id, count(*) as vote_count
    from public.dish_note_votes
    group by dish_note_id
  ) v on v.dish_note_id = d.id
  order by vote_count desc;

-- Tag vote counts
create view public.tags_ranked as
  select
    t.*,
    coalesce(v.vote_count, 0) as vote_count
  from public.tags t
  left join (
    select tag_id, count(*) as vote_count
    from public.tag_votes
    group by tag_id
  ) v on v.tag_id = t.id
  order by vote_count desc;


-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles      enable row level security;
alter table public.visits         enable row level security;
alter table public.dish_notes     enable row level security;
alter table public.dish_note_votes enable row level security;
alter table public.tags           enable row level security;
alter table public.tag_votes      enable row level security;
alter table public.lists          enable row level security;
alter table public.list_items     enable row level security;

-- Profiles: public read, own write
create policy "profiles_public_read"  on public.profiles for select using (true);
create policy "profiles_own_update"   on public.profiles for update using (auth.uid() = id);

-- Visits: public read (for counts), own write
create policy "visits_public_read"    on public.visits for select using (true);
create policy "visits_own_insert"     on public.visits for insert with check (auth.uid() = user_id);
create policy "visits_own_update"     on public.visits for update using (auth.uid() = user_id);
create policy "visits_own_delete"     on public.visits for delete using (auth.uid() = user_id);

-- Dish notes: public read, own write
create policy "dish_notes_public_read"   on public.dish_notes for select using (true);
create policy "dish_notes_own_insert"    on public.dish_notes for insert with check (auth.uid() = user_id);
create policy "dish_notes_own_update"    on public.dish_notes for update using (auth.uid() = user_id);
create policy "dish_notes_own_delete"    on public.dish_notes for delete using (auth.uid() = user_id);

-- Dish note votes: public read, own write
create policy "dish_note_votes_public_read" on public.dish_note_votes for select using (true);
create policy "dish_note_votes_own_insert"  on public.dish_note_votes for insert with check (auth.uid() = user_id);
create policy "dish_note_votes_own_delete"  on public.dish_note_votes for delete using (auth.uid() = user_id);

-- Tags: public read, authenticated write
create policy "tags_public_read"    on public.tags for select using (true);
create policy "tags_auth_insert"    on public.tags for insert with check (auth.uid() = created_by);
create policy "tags_own_delete"     on public.tags for delete using (auth.uid() = created_by);

-- Tag votes: public read, own write
create policy "tag_votes_public_read" on public.tag_votes for select using (true);
create policy "tag_votes_own_insert"  on public.tag_votes for insert with check (auth.uid() = user_id);
create policy "tag_votes_own_delete"  on public.tag_votes for delete using (auth.uid() = user_id);

-- Lists: public lists readable by all, private lists only by owner
create policy "lists_public_read"   on public.lists for select using (is_public or auth.uid() = user_id);
create policy "lists_own_insert"    on public.lists for insert with check (auth.uid() = user_id);
create policy "lists_own_update"    on public.lists for update using (auth.uid() = user_id);
create policy "lists_own_delete"    on public.lists for delete using (auth.uid() = user_id);

-- List items: inherit list visibility
create policy "list_items_read"     on public.list_items for select using (
  exists (
    select 1 from public.lists l
    where l.id = list_id and (l.is_public or l.user_id = auth.uid())
  )
);
create policy "list_items_own_insert" on public.list_items for insert with check (
  exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())
);
create policy "list_items_own_delete" on public.list_items for delete using (
  exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())
);


-- ============================================================
-- Indexes
-- ============================================================
create index on public.visits (restaurant_key);
create index on public.dish_notes (restaurant_key);
create index on public.tags (restaurant_key);
create index on public.list_items (list_id);
create index on public.list_items (restaurant_key);
