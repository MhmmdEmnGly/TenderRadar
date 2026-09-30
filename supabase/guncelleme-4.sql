-- Tender Radar — Güncelleme 4: Proje özetleri (ihale dokümanları + özet)
-- Supabase → SQL Editor → New query → bu dosyanın tamamını yapıştır → Run. Birden fazla kez çalıştırmak güvenlidir.

-- 1) Her kullanıcının ihale başına doküman listesi, okunan metinler ve özetleri (yalnızca sahibi görür)
create table if not exists public.proje_ozet (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tender_id  text not null,
  tender     jsonb,
  files      jsonb not null default '[]'::jsonb,
  texts      jsonb not null default '{}'::jsonb,
  summary    jsonb,
  ai         jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, tender_id)
);
alter table public.proje_ozet enable row level security;
drop policy if exists "proje_ozet sahibi" on public.proje_ozet;
create policy "proje_ozet sahibi" on public.proje_ozet
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.proje_ozet to authenticated;

-- 2) Doküman dosyaları için özel depolama alanı: her kullanıcı yalnızca kendi klasörünü (<user_id>/...) görür
insert into storage.buckets (id, name, public, file_size_limit)
values ('ihale-dokuman', 'ihale-dokuman', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "ihale-dokuman oku" on storage.objects;
drop policy if exists "ihale-dokuman yaz" on storage.objects;
drop policy if exists "ihale-dokuman guncelle" on storage.objects;
drop policy if exists "ihale-dokuman sil" on storage.objects;
create policy "ihale-dokuman oku" on storage.objects for select to authenticated
  using (bucket_id = 'ihale-dokuman' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "ihale-dokuman yaz" on storage.objects for insert to authenticated
  with check (bucket_id = 'ihale-dokuman' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "ihale-dokuman guncelle" on storage.objects for update to authenticated
  using (bucket_id = 'ihale-dokuman' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "ihale-dokuman sil" on storage.objects for delete to authenticated
  using (bucket_id = 'ihale-dokuman' and (storage.foldername(name))[1] = auth.uid()::text);
