# Tender Radar (Bulut) — Kurulum

Panel **GitHub Pages**'te, veri ve giriş **Supabase**'de, tarama **GitHub Actions**'ta çalışır. Hepsi ücretsiz katmanda.
Repoda veri yoktur; ihaleler, müşteri kartları ve notlar yalnızca giriş yapınca görünür.

## 1. Supabase projesi
1. [supabase.com](https://supabase.com) → GitHub ile giriş → **New project** → ad: `tender-radar`, bölge: **Frankfurt (eu-central-1)**.
2. Proje açılınca **Project Settings → API Keys** (veya **Data API**):
   - **Project URL** → `config.js` içindeki `supabaseUrl`
   - **anon / publishable** anahtar → `config.js` içindeki `supabaseAnonKey`
   - **service_role / secret** anahtar → yalnızca 3. adımda GitHub Secret olarak (asla dosyaya yazma)

## 2. Veritabanı tabloları
Supabase → **SQL Editor** → **New query** → `supabase/schema.sql` dosyasının tamamını yapıştır → **Run**.

## 3. Giriş kullanıcısı (kullanıcı adı + şifre)
1. Supabase → **Authentication → Users → Add user → Create new user**
   - Email: `kullaniciadin@tenderradar.app` (ör. `muhammed@tenderradar.app`) — gerçek adres olması gerekmez, e-posta gönderilmez
   - Password: kendi belirlediğin şifre
   - **Auto Confirm User** işaretli olsun
2. Panelde **kullanıcı adı** olarak yalnızca `muhammed` yazman yeterli.
3. Başkalarının kayıt olmasını kapat: **Authentication → Sign In / Providers → Email → "Allow new users to sign up" kapalı**.

## 4. GitHub
1. Repo → **Settings → Secrets and variables → Actions → New repository secret**
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_KEY` = service_role / secret anahtar
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**
3. Repo → **Actions** sekmesi → iş akışları etkin değilse etkinleştir.
   - **Yayın (GitHub Pages)** → *Run workflow* (panel yayınlanır)
   - **Tarama** → *Run workflow* (ilk tarama; ~3–6 dk)

Panel adresi: `https://<kullanıcı-adın>.github.io/<repo-adı>/`

## Nasıl çalışır
| Ne | Nerede | Ne zaman |
|---|---|---|
| Kontrol | Actions (Ubuntu, saniyeler) | 10 dakikada bir |
| Tam tarama | Actions (Windows PowerShell 5.1) | 08:00 sabah, 08–20 arası 3 saatte bir, kelime değişince, "Şimdi tara" ile |
| Panel yenileme | Tarayıcı | Dakikada bir yeni veri var mı bakar, varsa kendini yeniler |

## 5. Güncelleme 2 (geçmiş içe aktarma izni)
Supabase → SQL Editor → `supabase/guncelleme-2.sql` dosyasını yapıştır → **Run**.

## 5b. Güncelleme 3 (Kamu İhale Bülteni)
Supabase → SQL Editor → `supabase/guncelleme-3.sql` → **Run**. KİK'in herkese açık günlük bültenlerindeki tüm ihale,
iptal ve düzeltme ilanları bir sonraki taramadan itibaren toplanır (arşiv her taramada 10 iş günü geriye dolar;
hızlı doldurmak için Actions → "Kamu İhale Bülteni (elle)" → Run workflow).

## 5c. Güncelleme 4 (Proje özetleri — ihale dokümanları)
Supabase → SQL Editor → `supabase/guncelleme-4.sql` → **Run**. `proje_ozet` tablosunu ve yalnızca senin görebildiğin
`ihale-dokuman` depolama alanını oluşturur. Kullanım: Takip Listem → kartta **📄 Proje özeti** → EKAP'tan indirdiğin doküman
ZIP'ini (veya PDF/Word/Excel dosyalarını) sürükle. Dosyalar tarayıcıda okunur, özet çıkarılır; dosyalar ve özet hesabına kaydedilir.
İsteğe bağlı yapay zekâ özeti: sayfada **Gemini** (ücretsiz kota; anahtar: aistudio.google.com → Get API key) ya da **Claude** (ücretli; console.anthropic.com → API Keys) seç ve anahtarını gir;
anahtar yalnızca o tarayıcıda saklanır.

## 6. Yedek zamanlayıcı (önerilir)
GitHub'ın kendi zamanlayıcısı yeni repolarda gecikebilir. Supabase her 10 dakikada bir taramayı "kontrol" modunda tetikler:
1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
   - Repository access: **Only select repositories → TenderRadar**
   - Repository permissions → **Actions: Read and write** (başka yetki verme) · Süre: 1 yıl
2. Supabase → SQL Editor → `supabase/zamanlayici.sql` içeriğini yapıştır, iki yerdeki `GITHUB_ANAHTARI_BURAYA` yerine anahtarı yaz → **Run**.
3. Birkaç dakika sonra kontrol: `select status_code, created from net._http_response order by created desc limit 5;` → `204` görmelisin.

## 7. E-posta bildirimleri (Gmail ile)
1. Google hesabında **2 Adımlı Doğrulama** açık olmalı → https://myaccount.google.com/apppasswords → uygulama adı "Tender Radar" → 16 haneli **uygulama şifresi**.
2. GitHub repo → Settings → Secrets and variables → Actions → yeni secret'lar:
   - `SMTP_USER` = gmail adresin · `SMTP_PASS` = uygulama şifresi (boşluksuz) · `MAIL_TO` = raporun gideceği adres
   - (Gmail dışı için ayrıca `SMTP_HOST`, `SMTP_PORT`; varsayılan smtp.gmail.com:587)
3. Panel → Anahtar Kelimeler → **E-posta bildirimleri**: günlük rapor, 3 gün kala hatırlatma, kapsam (takip listem / tüm ihaleler), alıcı adresi.

## Yerel sürümden veri taşıma
- **Müşteri kartları, notlar, takip listesi, kelimeler:** yerel panel → Anahtar Kelimeler → **Yedek al** → bulut panel → Anahtar Kelimeler → **Yedeği yükle**.
- **İhale / haber / sözleşme geçmişi:** bulut panel → Kaynaklar → **Yerel geçmişi buluta aktar** → yerel `Tender Radar\scraper\store` klasöründeki
  `tenders.json`, `news.json`, `deals.json` dosyalarını seç. Bir sonraki taramada birleştirilir (aynı kayıt iki kez eklenmez).

## Güvenlik notları
- `config.js`'teki anon anahtar herkese açık olacak şekilde tasarlanmıştır; tüm tablolarda satır güvenliği (RLS) açıktır ve
  veri yalnızca giriş yapmış kullanıcıya görünür. Kullanıcı durumu (müşteri kartları, takip) yalnızca sahibine görünür.
- Tarama sonuçlarını yalnızca `service_role` anahtarıyla GitHub Actions yazabilir.
- Yeni kayıt kapalı olduğundan yalnızca Supabase panelinden eklediğin kullanıcılar girebilir.
