-- Tender Radar — Supabase şeması
-- Supabase panelinde: SQL Editor → New query → bu dosyanın tamamını yapıştır → Run
-- Tekrar çalıştırmak güvenlidir.

-- 1) Tarayıcının (GitHub Actions) ürettiği veri setleri: tenders, news, sources, version
--    Yalnızca giriş yapmış kullanıcı OKUYABİLİR. YAZMA yalnızca service_role anahtarıyla (GitHub Actions) yapılır.
create table if not exists public.datasets (
  key          text primary key,
  data         jsonb not null,
  generated_at timestamptz not null default now()
);
alter table public.datasets enable row level security;
drop policy if exists "datasets okuma" on public.datasets;
create policy "datasets okuma" on public.datasets for select to authenticated using (true);

-- 2) Kullanıcıya özel durum: müşteri kartları (crm), takip listesi (watch), tercihler.
--    Her kullanıcı yalnızca KENDİ satırını görür ve değiştirir. Cihazlar arası senkron buradan olur.
create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  crm        jsonb not null default '{}'::jsonb,
  watch      jsonb not null default '{}'::jsonb,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_state enable row level security;
drop policy if exists "user_state okuma" on public.user_state;
drop policy if exists "user_state ekleme" on public.user_state;
drop policy if exists "user_state guncelleme" on public.user_state;
create policy "user_state okuma"      on public.user_state for select to authenticated using (user_id = auth.uid());
create policy "user_state ekleme"     on public.user_state for insert to authenticated with check (user_id = auth.uid());
create policy "user_state guncelleme" on public.user_state for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 3) Ortak ayarlar: anahtar kelimeler (taramada ne aranacağı) ve "Şimdi tara" isteği.
--    Panel (giriş yapmış kullanıcı) okur/yazar; GitHub Actions service_role ile okur.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "app_settings okuma" on public.app_settings;
drop policy if exists "app_settings ekleme" on public.app_settings;
drop policy if exists "app_settings guncelleme" on public.app_settings;
create policy "app_settings okuma"      on public.app_settings for select to authenticated using (true);
create policy "app_settings ekleme"     on public.app_settings for insert to authenticated with check (key in ('keywords', 'scan_request', 'history_import'));
create policy "app_settings guncelleme" on public.app_settings for update to authenticated using (key in ('keywords', 'scan_request', 'history_import')) with check (key in ('keywords', 'scan_request', 'history_import'));
