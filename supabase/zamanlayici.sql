-- Tender Radar — yedek zamanlayıcı (Supabase pg_cron → GitHub Actions)
--
-- GitHub'ın kendi zamanlayıcısı yeni/az etkinlikli repolarda gecikebilir ya da hiç çalışmayabilir.
-- Bu betik Supabase'in yerleşik zamanlayıcısıyla 10 dakikada bir "Tarama" iş akışını mod=kontrol ile
-- tetikler; iş akışı yalnızca gerekirse (sabah, 3 saatte bir, kelime değişimi, "Şimdi tara") tam tarama yapar.
--
-- ÖNCE: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
--   - Repository access: Only select repositories → TenderRadar
--   - Permissions → Repository permissions → Actions: Read and write   (başka yetki VERMEYİN)
--   - Expiration: 1 yıl (süre dolunca bu betiği yeni anahtarla tekrar çalıştırın)
-- SONRA: aşağıdaki GITHUB_ANAHTARI_BURAYA yerine anahtarı yapıştırıp tüm betiği çalıştırın.
-- Anahtar Supabase Vault'ta şifreli saklanır; bu sorguyu kaydetmeyin/paylaşmayın.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Anahtarı Vault'a yaz (varsa güncelle)
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'tender_radar_github';
  if v_id is null then
    perform vault.create_secret('GITHUB_ANAHTARI_BURAYA', 'tender_radar_github', 'Tender Radar: Actions tetikleme anahtarı');
  else
    perform vault.update_secret(v_id, 'GITHUB_ANAHTARI_BURAYA');
  end if;
end $$;

-- Varsa eski görevi kaldır, 10 dakikada bir tetikle
select cron.unschedule(jobid) from cron.job where jobname = 'tender-radar-kontrol';
select cron.schedule('tender-radar-kontrol', '*/10 * * * *', $cron$
  select net.http_post(
    url     := 'https://api.github.com/repos/MhmmdEmnGly/TenderRadar/actions/workflows/tarama.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'tender_radar_github'),
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'tender-radar-pg-cron',
      'Content-Type', 'application/json'),
    body    := '{"ref":"main","inputs":{"mod":"kontrol"}}'::jsonb
  );
$cron$);

-- Kontrol: son tetikleme yanıtları (204 = başarılı). Birkaç dakika sonra çalıştırın:
-- select status_code, content, created from net._http_response order by created desc limit 5;
