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

## Yerel sürümden veri taşıma
Yerel panel → Anahtar Kelimeler → **Yedek al** → bulut panel → Anahtar Kelimeler → **Yedeği yükle**.
Müşteri kartları, notlar, takip listesi ve kelimeler buluta aktarılır.

## Güvenlik notları
- `config.js`'teki anon anahtar herkese açık olacak şekilde tasarlanmıştır; tüm tablolarda satır güvenliği (RLS) açıktır ve
  veri yalnızca giriş yapmış kullanıcıya görünür. Kullanıcı durumu (müşteri kartları, takip) yalnızca sahibine görünür.
- Tarama sonuçlarını yalnızca `service_role` anahtarıyla GitHub Actions yazabilir.
- Yeni kayıt kapalı olduğundan yalnızca Supabase panelinden eklediğin kullanıcılar girebilir.
