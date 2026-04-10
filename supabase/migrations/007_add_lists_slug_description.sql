alter table public.lists add column if not exists slug text unique;
alter table public.lists add column if not exists description text;
create index if not exists lists_slug_idx on public.lists (slug);
