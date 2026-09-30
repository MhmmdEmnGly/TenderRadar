/*
 * Tender Radar — bulut ayarları (tarayıcı tarafı).
 * Bu iki değer GİZLİ DEĞİLDİR: "anon" anahtar tarayıcıda kullanılmak için tasarlanmıştır; verilere erişim
 * Supabase'deki satır güvenliği (RLS) + kullanıcı girişi ile korunur.
 * service_role anahtarını ASLA buraya yazma — o yalnızca GitHub Secrets'ta durur.
 */
window.TR_CONFIG = {
  supabaseUrl: "https://jtnihjeyfoilbsrfcmia.supabase.co",
  supabaseAnonKey: "sb_publishable_vWb_FHsmSrOZjDxD83XMpQ_mVo0zp5L", // publishable (tarayıcı için tasarlanmış, gizli değil)
  // Kullanıcı adıyla giriş: "muhammed" yazılırsa "muhammed@tenderradar.app" hesabıyla oturum açılır.
  // Supabase'de kullanıcıyı bu biçimde oluştur (SETUP.md). Tam e-posta ile de giriş yapılabilir.
  usernameDomain: "tenderradar.app",
  // Panel dosyalarının sürümü: değiştirilince tarayıcılar app.js / proje.js dosyalarını yeniden indirir
  version: "2026-09-30.1"
};
