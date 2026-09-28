-- Tender Radar — güncelleme 2
-- Panelden "geçmiş veri içe aktarma" (history_import) izni.
-- Supabase → SQL Editor → New query → yapıştır → Run. Tekrar çalıştırmak güvenlidir.

drop policy if exists "app_settings ekleme" on public.app_settings;
drop policy if exists "app_settings guncelleme" on public.app_settings;
create policy "app_settings ekleme" on public.app_settings for insert to authenticated
  with check (key in ('keywords', 'scan_request', 'history_import'));
create policy "app_settings guncelleme" on public.app_settings for update to authenticated
  using (key in ('keywords', 'scan_request', 'history_import'))
  with check (key in ('keywords', 'scan_request', 'history_import'));
