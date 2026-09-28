/*
 * Tender Radar — bulut katmanı (Supabase).
 * 1) Kullanıcı adı + şifre ile giriş (Supabase Auth)
 * 2) Tarayıcının ürettiği veriyi (datasets) ve kullanıcının kendi durumunu (user_state) yükler
 * 3) window.TR_DATA ve window.TR_CLOUD'u hazırlayıp paneli (app.js) başlatır
 */
(function () {
  "use strict";

  const cfg = window.TR_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const gate = $("#authGate");
  const configured = cfg.supabaseUrl && cfg.supabaseAnonKey && !/BURAYA/.test(cfg.supabaseUrl + cfg.supabaseAnonKey);

  function showGate(html) { gate.innerHTML = html; gate.hidden = false; document.body.classList.add("gated"); }
  function hideGate() { gate.hidden = true; document.body.classList.remove("gated"); }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const brand = `<div class="auth-brand"><svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".6"/><path d="M12 12 L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></svg><div><strong>Tender Radar</strong><small>İş Geliştirme Paneli</small></div></div>`;

  if (!configured) {
    showGate(`<div class="auth-card">${brand}<h2>Kurulum tamamlanmadı</h2>
      <p class="muted">Supabase bağlantısı yapılandırılmamış. <code>config.js</code> dosyasına Supabase proje adresini ve anon anahtarını yaz (bkz. <code>SETUP.md</code>).</p></div>`);
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    showGate(`<div class="auth-card">${brand}<h2>Bağlantı hatası</h2><p class="muted">Supabase kütüphanesi yüklenemedi. İnternet bağlantını kontrol edip sayfayı yenile.</p></div>`);
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "tender-radar-auth" }
  });
  const toEmail = (u) => (u.includes("@") ? u.trim() : `${u.trim().toLowerCase()}@${cfg.usernameDomain}`);
  const usernameOf = (user) => {
    const e = user?.email || "";
    return e.endsWith("@" + cfg.usernameDomain) ? e.slice(0, -(cfg.usernameDomain.length + 1)) : e;
  };

  function showLogin(message) {
    showGate(`<form class="auth-card" id="loginForm" autocomplete="on">
      ${brand}
      <h2>Giriş yap</h2>
      <label>Kullanıcı adı<input class="input" name="username" autocomplete="username" required autofocus></label>
      <label>Şifre<input class="input" name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit">Giriş</button>
      <p class="auth-msg ${message ? "err" : ""}" id="loginMsg">${esc(message || "")}</p>
    </form>`);
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = e.target.querySelector("button");
      btn.disabled = true; btn.textContent = "Giriş yapılıyor…";
      const { data, error } = await sb.auth.signInWithPassword({ email: toEmail(fd.get("username")), password: fd.get("password") });
      if (error) {
        btn.disabled = false; btn.textContent = "Giriş";
        const m = $("#loginMsg");
        m.className = "auth-msg err";
        m.textContent = /invalid/i.test(error.message) ? "Kullanıcı adı veya şifre hatalı." : "Giriş yapılamadı: " + error.message;
        return;
      }
      boot(data.session);
    });
  }

  async function boot(session) {
    showGate(`<div class="auth-card">${brand}<p class="muted">Veriler yükleniyor…</p></div>`);
    const uid = session.user.id;
    const [ds, us, st] = await Promise.all([
      sb.from("datasets").select("key,data,generated_at"),
      sb.from("user_state").select("crm,watch,prefs").eq("user_id", uid).maybeSingle(),
      sb.from("app_settings").select("key,value,updated_at")
    ]);
    const err = ds.error || us.error || st.error;
    if (err) {
      if (/JWT|expired|auth/i.test(err.message)) { await sb.auth.signOut(); showLogin("Oturum süresi doldu, tekrar giriş yap."); return; }
      showGate(`<div class="auth-card">${brand}<h2>Veri yüklenemedi</h2><p class="muted">${esc(err.message)}</p>
        <p class="muted small">Supabase'de <code>supabase/schema.sql</code> çalıştırıldı mı? (SETUP.md, adım 2)</p>
        <button class="btn" onclick="location.reload()">Tekrar dene</button></div>`);
      return;
    }
    const by = Object.fromEntries((ds.data || []).map((r) => [r.key, r]));
    const settings = Object.fromEntries((st.data || []).map((r) => [r.key, r.value]));

    window.TR_DATA = {
      demo: false,
      generatedAt: by.version?.data?.generatedAt || by.version?.generated_at || null,
      tenders: by.tenders?.data || [],
      news: by.news?.data?.news || [],
      deals: by.news?.data?.deals || [],
      sources: by.sources?.data?.sources || [],
      keywords: by.sources?.data?.keywords || null
    };

    // ---- Kullanıcı durumunu (crm, watch) Supabase'e senkronla: değişiklikten 700 ms sonra tek istek
    const pending = {};
    let timer = null;
    let lastError = null;
    async function flush() {
      clearTimeout(timer); timer = null;
      const keys = Object.keys(pending);
      if (!keys.length) return;
      const row = { user_id: uid, updated_at: new Date().toISOString() };
      keys.forEach((k) => { row[k] = pending[k]; delete pending[k]; });
      const { error } = await sb.from("user_state").upsert(row, { onConflict: "user_id" });
      lastError = error ? error.message : null;
      if (error) { keys.forEach((k) => { if (!(k in pending)) pending[k] = row[k]; }); window.TR_CLOUD?.onSyncError?.(error.message); }
    }
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
    window.addEventListener("pagehide", flush);

    window.TR_CLOUD = {
      user: session.user,
      username: usernameOf(session.user),
      state: { crm: us.data?.crm ?? null, watch: us.data?.watch ?? null, prefs: us.data?.prefs ?? null },
      keywords: settings.keywords || null,          // panelde düzenlenen, taranması istenen liste
      scanRequest: settings.scan_request || null,
      save(key, value) { pending[key] = value; clearTimeout(timer); timer = setTimeout(flush, 700); },
      flush,
      get lastError() { return lastError; },
      async saveKeywords(kw) {
        const value = { pos: kw.pos, neg: kw.neg, updatedAt: kw.updatedAt || new Date().toISOString() };
        const { error } = await sb.from("app_settings").upsert({ key: "keywords", value, updated_at: new Date().toISOString() }, { onConflict: "key" });
        if (error) throw new Error(error.message);
        this.keywords = value;
      },
      async requestScan() {
        const value = { requestedAt: new Date().toISOString(), by: this.username };
        const { error } = await sb.from("app_settings").upsert({ key: "scan_request", value, updated_at: value.requestedAt }, { onConflict: "key" });
        if (error) throw new Error(error.message);
        this.scanRequest = value;
      },
      // Yerel sürümün geçmişini (scraper/store/*.json) buluta aktarma isteği; bir sonraki taramada birleştirilir
      async importHistory(payload) {
        const value = { ...payload, requestedAt: new Date().toISOString(), by: this.username };
        const { error } = await sb.from("app_settings").upsert({ key: "history_import", value, updated_at: value.requestedAt }, { onConflict: "key" });
        if (error) throw new Error(error.message);
      },
      // Gerektiğinde yüklenen ek veri setleri (ör. e-posta günlüğü)
      async getDataset(key) {
        const { data, error } = await sb.from("datasets").select("data,generated_at").eq("key", key).maybeSingle();
        if (error) throw new Error(error.message);
        return data ? data.data : null;
      },
      async latestVersion() {
        const { data, error } = await sb.from("datasets").select("data,generated_at").eq("key", "version").maybeSingle();
        if (error || !data) return null;
        return { generatedAt: data.data?.generatedAt || data.generated_at, tenderIds: data.data?.tenderIds || [] };
      },
      async signOut() { await flush(); await sb.auth.signOut(); location.reload(); }
    };

    hideGate();
    const s = document.createElement("script");
    s.src = "assets/js/app.js?v=" + encodeURIComponent(cfg.version || "1");
    document.body.appendChild(s);
  }

  sb.auth.getSession().then(({ data }) => (data.session ? boot(data.session) : showLogin()));
})();
