/*
 * Tender Radar — bulut ayarları (tarayıcı tarafı).
 * Bu iki değer GİZLİ DEĞİLDİR: "anon" anahtar tarayıcıda kullanılmak için tasarlanmıştır; verilere erişim
 * Supabase'deki satır güvenliği (RLS) + kullanıcı girişi ile korunur.
 * service_role anahtarını ASLA buraya yazma — o yalnızca GitHub Secrets'ta durur.
 */
window.TR_CONFIG = {
  supabaseUrl: "SUPABASE_URL_BURAYA",          // ör. https://abcdefghijkl.supabase.co
  supabaseAnonKey: "SUPABASE_ANON_KEY_BURAYA", // Project Settings → API Keys → anon / publishable
  // Kullanıcı adıyla giriş: "muhammed" yazılırsa "muhammed@tenderradar.app" hesabıyla oturum açılır.
  // Supabase'de kullanıcıyı bu biçimde oluştur (SETUP.md). Tam e-posta ile de giriş yapılabilir.
  usernameDomain: "tenderradar.app"
};
