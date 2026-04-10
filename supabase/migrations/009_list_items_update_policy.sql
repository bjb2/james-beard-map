-- Allow list owners to update their list items (e.g. per-restaurant notes)
create policy "list_items_own_update" on public.list_items for update using (
  exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())
);
