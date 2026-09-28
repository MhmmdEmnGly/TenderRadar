/* Tender Radar — framework'süz, kurulum gerektirmeyen tek sayfa uygulama. */
(function () {
  "use strict";

  const DATA = window.TR_DATA || {};
  const CLOUD = window.TR_CLOUD || null;   // Supabase katmanı (cloud.js); yoksa yerel mod
  const tenders = DATA.tenders || [];
  const news = DATA.news || [];
  const deals = DATA.deals || [];
  const sources = DATA.sources || [];

  // ---------- Kalıcı durum ----------
  // Bulut modunda müşteri kartları ve takip listesi Supabase'e yazılır (tüm cihazlarda aynı);
  // tema, filtre gibi cihaz tercihleri bu tarayıcıda kalır.
  const CLOUD_KEYS = { crm: true, watch: true, prefs: true };
  const store = {
    get(key, fallback) {
      if (CLOUD && CLOUD_KEYS[key]) { const v = CLOUD.state[key]; return v == null ? fallback : v; }
      try { const v = localStorage.getItem("tr." + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      if (CLOUD && CLOUD_KEYS[key]) { CLOUD.state[key] = value; CLOUD.save(key, value); return; }
      try { localStorage.setItem("tr." + key, JSON.stringify(value)); } catch { /* gizli pencere vb. */ }
    }
  };

  // Anahtar kelimelerin tek kaynağı scraper/keywords.json'dur; son taramada kullanılan liste DATA.keywords ile gelir.
  // Panelde yapılan değişiklik önce bu tarayıcıda saklanır, klasör bağlıysa keywords.json'a yazılır ve
  // 30 dakikalık kontrol görevi yeni listeyle taramayı başlatır.
  const SERVER_KW = DATA.keywords || null;
  const DEFAULT_KEYWORDS = SERVER_KW ? { pos: [...SERVER_KW.pos], neg: [...SERVER_KW.neg], updatedAt: SERVER_KW.updatedAt } : {
    pos: ["scada", "otomasyon", "rtu", "plc", "telekontrol", "telemetri", "iec 61850", "iec 60870", "dağıtım merkezi",
          "trafo merkezi", "adms", "oms", "dcs", "uzaktan izleme", "akıllı sayaç", "osos", "enerji yönetim"],
    neg: ["temizlik", "yemek", "akaryakıt", "kırtasiye"]
  };
  function initialKeywords() {
    if (CLOUD) {
      // Bulutta tek kaynak Supabase'deki app_settings.keywords (tüm cihazlarda aynı)
      const k = CLOUD.keywords;
      return k && Array.isArray(k.pos) ? { pos: [...k.pos], neg: [...(k.neg || [])], updatedAt: k.updatedAt } : JSON.parse(JSON.stringify(DEFAULT_KEYWORDS));
    }
    const local = store.get("keywords", null);
    // Yerel liste, dosyadaki listeden daha yeniyse (henüz taranmamış bir düzenleme) onu kullan
    if (local && local.updatedAt && (!SERVER_KW || new Date(local.updatedAt) > new Date(SERVER_KW.updatedAt || 0))) return local;
    return JSON.parse(JSON.stringify(DEFAULT_KEYWORDS));
  }

  const STATUSES = [
    { id: "takip", label: "Takipte" },
    { id: "hazirlik", label: "Teklif Hazırlanıyor" },
    { id: "verildi", label: "Teklif Verildi" },
    { id: "kapandi", label: "Sonuçlandı / Pas" }
  ];

  const SOURCE_TYPES = { EKAP: "EKAP", EDAS: "EDAŞ", OZEL: "Özel Sektör", ILAN: "ilan.gov.tr", OSB: "OSB" };

  const state = {
    view: "ozet",
    q: "",
    watch: store.get("watch", {}),       // { tenderId: { status, note, addedAt } }
    keywords: initialKeywords(),
    f: store.get("filters", { src: [], cat: "", city: "", onlyRelevant: false, sort: "date" }),
    newsType: "",
    newsRelevant: store.get("newsRelevant", true),
    piyasaTab: "haber",
    param: null,
    custFilter: store.get("custFilter", { seg: "", pinned: false, sort: "active" }),
    instFilter: store.get("instFilter", { il: "", seg: "", top: 7 }),
    mapFilter: store.get("mapFilter", { metric: "active", seg: "", sel: null }),
    showAddCustomer: false,
    dealSort: { key: "date", dir: -1 }
  };

  const saveWatch = () => { store.set("watch", state.watch); updateNavCounts(); };
  const saveFilters = () => store.set("filters", state.f);

  // ---------- Yardımcılar ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const trLower = (s) => String(s || "").toLocaleLowerCase("tr-TR");
  const DAY = 86400000;

  const daysLeft = (iso) => (new Date(iso) - Date.now()) / DAY;
  const bucketOf = (iso) => {
    const d = daysLeft(iso);
    if (d < 0) return "past";
    if (d <= 3) return "urgent";
    if (d <= 7) return "week";
    return "later";
  };
  const BUCKETS = {
    urgent: { label: "3 günden az", hint: "Acil — teklif hazırlığı şimdi" },
    week: { label: "3–7 gün", hint: "Bu hafta" },
    later: { label: "7 günden fazla", hint: "Planlama için zaman var" },
    past: { label: "Süresi geçmiş", hint: "Sonuç takibi" },
    cancel: { label: "İptal", hint: "İdare ihaleyi iptal etti" }
  };

  function countdown(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms < 0) return "Süresi doldu";
    const h = Math.floor(ms / 3600000);
    const days = Math.floor(h / 24);
    if (days >= 1) return `${days} gün ${h % 24} sa`;
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h} sa ${m} dk`;
  }
  const fmtDate = (iso, withTime = true) => new Date(iso).toLocaleString("tr-TR", withTime
    ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short" }
    : { day: "2-digit", month: "short", year: "numeric" });
  const relDate = (iso) => {
    const d = Math.round((Date.now() - new Date(iso)) / DAY);
    return d <= 0 ? "Bugün" : d === 1 ? "Dün" : `${d} gün önce`;
  };
  function fmtMoney(v) {
    if (!v || v.amount == null) return "—";
    const n = v.amount;
    const sym = { TRY: "₺", EUR: "€", USD: "$" }[v.currency] || v.currency + " ";
    if (n >= 1e9) return `${sym}${(n / 1e9).toLocaleString("tr-TR", { maximumFractionDigits: 2 })} Mr`;
    if (n >= 1e6) return `${sym}${(n / 1e6).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} Mn`;
    return `${sym}${n.toLocaleString("tr-TR")}`;
  }

  // Kelime başı sınırı zorunlu ("dhmi" içinde "hmi" eşleşmesin); ≤4 harfli kısaltmalarda kelime sonu da zorunlu
  const kwCache = new Map();
  // Türkçe küçültmede "IEC" → "ıec" olur; kelime eşleştirmede ı/i farkı yok sayılır
  const fold = (s) => trLower(s).replace(/ı/g, "i");
  function kwMatch(hay, k) {
    hay = hay.replace(/ı/g, "i");
    const key = fold(k);
    if (!kwCache.has(key)) {
      const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      kwCache.set(key, new RegExp(`(?<![\\p{L}\\p{N}])${esc}${key.length <= 4 ? "(?![\\p{L}\\p{N}])" : ""}`, "u"));
    }
    return kwCache.get(key).test(hay);
  }
  // Anahtar kelime ile alaka puanı: pozitif eşleşme +, negatif eşleşme dışlar
  function relevance(t) {
    const hay = trLower([t.title, t.summary, (t.categories || []).join(" ")].join(" "));
    if (state.keywords.neg.some((k) => kwMatch(hay, k))) return { score: -1, hits: [] };
    const hits = state.keywords.pos.filter((k) => kwMatch(hay, k));
    return { score: hits.length, hits };
  }

  function matchesQuery(obj, fields) {
    if (!state.q) return true;
    const hay = trLower(fields.map((f) => (Array.isArray(obj[f]) ? obj[f].join(" ") : obj[f])).join(" "));
    return trLower(state.q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  function hl(text) {
    const s = esc(text);
    if (!state.q) return s;
    const words = state.q.trim().split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!words.length) return s;
    return s.replace(new RegExp(`(${words.map(esc).join("|")})`, "gi"), "<mark>$1</mark>");
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // ---------- Filtrelenmiş ihale listesi ----------
  const refOf = (t) => t.ikn || t.refNo || (t.adNo ? "İlan " + t.adNo : t.id);
  const dateLabel = (t) => (t.dateKind === "Teklif son teslim" ? "Son teklif" : "İhale");
  const whenText = (t) => t.timeKnown === false
    ? new Date(t.tenderDate).toLocaleDateString("tr-TR", { day: "2-digit", month: "short", year: "numeric", weekday: "short" }) + " (saat ilanda yok)"
    : fmtDate(t.tenderDate);

  // ---------- Listeden çıkarma + süresi dolanların temizlenmesi ----------
  // İhale tarihinden 3 gün sonra ihale tüm listelerden kalkar (analitik ve müşteri kartı geçmişinde kalır).
  // Kullanıcının "✕" ile çıkardıkları prefs.dismissed'da tutulur (hesaba kayıtlı, tüm cihazlarda aynı).
  const EXPIRE_DAYS = 3;
  const isExpired = (t) => daysLeft(t.tenderDate) < -EXPIRE_DAYS;
  const dismissedMap = () => prefs().dismissed || {};
  const isDismissed = (t) => Object.prototype.hasOwnProperty.call(dismissedMap(), t.id);
  const listable = (t) => !isExpired(t) && !isDismissed(t);
  function purgeDismissed() {
    const p = prefs(); const d = { ...(p.dismissed || {}) }; let changed = false;
    for (const [id, x] of Object.entries(d)) {
      const t = tenders.find((y) => y.id === id);
      const date = t ? t.tenderDate : x.date;
      if (!date || daysLeft(date) < -EXPIRE_DAYS) { delete d[id]; changed = true; }
    }
    if (changed) { p.dismissed = d; savePrefs(p); }
  }
  function dismissTender(id) {
    const t = tenders.find((x) => x.id === id); if (!t) return;
    const p = prefs(); p.dismissed = { ...(p.dismissed || {}), [id]: { at: new Date().toISOString(), title: t.title, authority: t.authority, date: t.tenderDate } };
    savePrefs(p);
    if (state.watch[id]) { delete state.watch[id]; saveWatch(); }   // çıkarılan ihale takipten de düşer
    invalidateCustomers(); closeDrawer(); render(); updateNavCounts();
    toast("İhale listeden çıkarıldı — sayfanın altındaki \"Listeden çıkardığım ihaleler\" bölümünden geri alabilirsin");
  }
  function restoreTender(id) {
    const p = prefs(); const d = { ...(p.dismissed || {}) }; delete d[id]; p.dismissed = d; savePrefs(p);
    invalidateCustomers(); render(); updateNavCounts(); toast("İhale listeye geri alındı");
  }
  // Yanlışlıkla basmaya karşı onay penceresi (varsayılan odak "Vazgeç"te)
  function confirmBox({ title, html, ok, cancel = "Vazgeç" }) {
    return new Promise((resolve) => {
      const m = document.createElement("div");
      m.className = "modal-backdrop";
      m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle"><h3 id="mTitle">${esc(title)}</h3><div class="modal-body">${html}</div>
        <div class="actions modal-actions"><button class="btn" data-m="no" type="button">${esc(cancel)}</button><button class="btn danger" data-m="yes" type="button">${esc(ok)}</button></div></div>`;
      document.body.appendChild(m);
      const done = (v) => { m.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
      document.addEventListener("keydown", onKey, true);
      m.addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (b) done(b.dataset.m === "yes"); else if (e.target === m) done(false); });
      m.querySelector('[data-m="no"]').focus();
    });
  }

  function filteredTenders() {
    return tenders
      .filter(listable)
      .map((t) => ({ ...t, rel: relevance(t), bucket: t.isCancelled ? "cancel" : bucketOf(t.tenderDate) }))
      .filter((t) => t.rel.score >= 0)
      .filter((t) => !state.f.onlyRelevant || t.rel.score > 0)
      .filter((t) => !state.f.src.length || state.f.src.includes(t.sourceType))
      .filter((t) => !state.f.cat || (t.categories || []).includes(state.f.cat))
      .filter((t) => !state.f.city || t.city === state.f.city)
      .filter((t) => matchesQuery(t, ["title", "summary", "authority", "ikn", "city", "categories", "sourceName"]))
      .sort((a, b) => state.f.sort === "score"
        ? b.rel.score - a.rel.score || new Date(a.tenderDate) - new Date(b.tenderDate)
        : new Date(a.tenderDate) - new Date(b.tenderDate));
  }

  // ---------- Sözleşme / haber yardımcıları ----------
  function discountOf(x) {
    if (!x.amount || !x.estimate || x.amount.currency !== x.estimate.currency || !x.estimate.amount) return null;
    return Math.round(((x.estimate.amount - x.amount.amount) / x.estimate.amount) * 1000) / 10;
  }
  const NEWS_FOCUS = ["scada", "otomasyon", "edaş", "elektrik dağıtım", "dağıtım şirket", "trafo", "teiaş", "epdk", "şebeke",
    "enerji", "elektrik", "ges", "res", "hes", "depolama", "akıllı sayaç", "arıtma", "su", "kontrol"];
  const newsRelevant = (n) => {
    const hay = trLower(`${n.title} ${n.summary} ${(n.tags || []).join(" ")}`);
    return NEWS_FOCUS.some((k) => kwMatch(hay, k)) || state.keywords.pos.some((k) => kwMatch(hay, k));
  };

  // ---------- Müşteri (idare / işveren) eşleştirme ----------
  const trUpper = (s) => String(s || "").toLocaleUpperCase("tr-TR");
  function customerKey(name) {
    return trUpper(name)
      .replace(/ANON[İI]M\s+Ş[İI]RKET[İI]/g, " ").replace(/\bA\.?\s?Ş\.?(?=\s|$)/g, " ")
      .replace(/\s+GENEL\s+MÜDÜRLÜĞÜ\s*$/g, " ")
      .replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  }
  function titleTR(s) {
    return String(s || "").toLocaleLowerCase("tr-TR").replace(/(^|[\s(\-/])(\p{L})/gu, (m, p, c) => p + c.toLocaleUpperCase("tr-TR"))
      .replace(/\bA\.ş\.?/g, "A.Ş.").replace(/\b(Ve|İle|İçin)\b/g, (w) => w.toLocaleLowerCase("tr-TR"));
  }
  function segmentOf(name) {
    const n = trUpper(name);
    if (/ELEKTR[İI]K DAĞITIM|EDAŞ\b|EDAS\b/.test(n)) return "EDAŞ";
    if (/ELEKTR[İI]K [İI]LET[İI]M|TE[İI]AŞ|EÜAŞ|BOTAŞ|ENERJ[İI]/.test(n)) return "Enerji (kamu)";
    if (/SU VE KANAL[İI]ZASYON|\bSK[İI]\b|[İI]SK[İI]|DS[İI]\b|SU [İI]ŞLER[İI]/.test(n)) return "Su idaresi";
    if (/ORGAN[İI]ZE SANAY[İI]|\bOSB\b/.test(n)) return "OSB";
    if (/DEM[İI]RYOL|TCDD|METRO|RAYLI/.test(n)) return "Raylı sistem";
    if (/BELED[İI]YE/.test(n)) return "Belediye";
    return "Diğer";
  }
  const SEGMENTS = ["EDAŞ", "Enerji (kamu)", "Su idaresi", "OSB", "Belediye", "Raylı sistem", "Özel sektör", "Diğer"];
  const STOP = new Set(["GENEL", "MÜDÜRLÜĞÜ", "BAŞKANLIĞI", "İDARESİ", "VE", "İL", "ŞİRKETİ", "ANONİM", "BÖLGE", "A", "Ş", "DAİRE", "BİRİMİ"]);
  // Sektörde yaygın kullanılan kısaltmalar (haber eşleştirmesi için)
  const EDAS_ABBR = { "ULUDAĞ": "UEDAŞ", "YEŞİLIRMAK": "YEDAŞ", "SAKARYA": "SEDAŞ", "AKDENİZ": "AEDAŞ", "ÇAMLIBEL": "ÇEDAŞ", "VANGÖLÜ": "VEDAŞ",
    "BOĞAZİÇİ": "BEDAŞ", "DİCLE": "DEDAŞ", "MERAM": "MEDAŞ", "OSMANGAZİ": "OEDAŞ", "TRAKYA": "TREDAŞ", "FIRAT": "FEDAŞ", "KAYSERİ": "KCETAŞ",
    "AYDEM": "ADM EDAŞ", "İSTANBUL ANADOLU YAKASI": "AYEDAŞ", "AKEDAŞ": "AKEDAŞ" };
  const ORG_ABBR = [[/ELEKTR[İI]K [İI]LET[İI]M/, "TEİAŞ"], [/ELEKTR[İI]K ÜRET[İI]M/, "EÜAŞ"], [/BORU HATLARI [İI]LE PETROL/, "BOTAŞ"],
    [/DEVLET SU [İI]ŞLER[İI]/, "DSİ"], [/DEVLET DEM[İI]RYOLLARI/, "TCDD"], [/DEVLET HAVA MEYDANLARI/, "DHMİ"], [/[İI]ZM[İI]R SU VE KANAL/, "İZSU"],
    [/ANKARA SU VE KANAL/, "ASKİ"], [/[İI]STANBUL SU VE KANAL/, "İSKİ"], [/[İI]LLER BANKASI/, "İLBANK"]];
  const SKI_ABBR = { "ANKARA": "ASKİ", "İSTANBUL": "İSKİ", "İZMİR": "İZSU", "DİYARBAKIR": "DİSKİ", "SAKARYA": "SASKİ", "BURSA": "BUSKİ",
    "KONYA": "KOSKİ", "MERSİN": "MESKİ", "ANTALYA": "ASAT", "KAYSERİ": "KASKİ", "GAZİANTEP": "GASKİ", "ŞANLIURFA": "ŞUSKİ", "ESKİŞEHİR": "ESKİ",
    "MANİSA": "MASKİ", "DENİZLİ": "DESKİ", "KOCAELİ": "İSU", "ADANA": "ASKİ", "SAMSUN": "SASKİ", "MUĞLA": "MUSKİ", "AYDIN": "ASKİ",
    "TEKİRDAĞ": "TESKİ", "BALIKESİR": "BASKİ", "MALATYA": "MASKİ", "ERZURUM": "ESKİ", "HATAY": "HATSU", "KAHRAMANMARAŞ": "KASKİ",
    "TRABZON": "TİSKİ", "VAN": "VASKİ", "ORDU": "ORSU", "MARDİN": "MARSU" };
  function aliasesOf(name, extra) {
    const n = trUpper(name);
    const out = new Set();
    (n.match(/\(([^)]{2,20})\)/g) || []).forEach((p) => out.add(p.slice(1, -1).trim()));      // (İSKİ), (DHMİ)
    const edas = n.match(/^(.+?)\s+ELEKTR[İI]K\s+DAĞITIM/);
    if (edas) {
      out.add(`${edas[1]} EDAŞ`); out.add(`${edas[1]} ELEKTRİK DAĞITIM`);
      if (EDAS_ABBR[edas[1]]) out.add(EDAS_ABBR[edas[1]]);
    }
    ORG_ABBR.forEach(([re, ab]) => { if (re.test(n)) out.add(ab); });
    const ski = n.match(/^(\S+)\s+(?:BÜYÜKŞEH[İI]R BELED[İI]YES[İI]\s+)?SU VE KANAL[İI]ZASYON/);
    if (ski && SKI_ABBR[ski[1]]) out.add(SKI_ABBR[ski[1]]);
    // İlk anlamlı kelimeler ("ve", "genel" gibi dolgu kelimeleri hariç), en az iki kelime
    const words = customerKey(name).split(" ").filter((w) => w.length > 1);
    const firstSig = [];
    for (const w of words) { if (STOP.has(w)) break; firstSig.push(w); if (firstSig.length === 3) break; }
    if (firstSig.length >= 2) out.add(firstSig.join(" "));
    String(extra || "").split(",").map((s) => trUpper(s.trim())).filter((s) => s.length >= 3).forEach((s) => out.add(s));
    return [...out].filter((a) => a.length >= 3);
  }
  const aliasRe = new Map();
  function mentions(text, aliases) {
    const h = trUpper(text);
    return aliases.some((a) => {
      if (!aliasRe.has(a)) aliasRe.set(a, new RegExp(`(?<![\\p{L}\\p{N}])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u"));
      return aliasRe.get(a).test(h);
    });
  }
  // İşveren metni (ör. "Devlet Su İşleri (DSİ) 19. Bölge (Sivas) Müdürlüğü") ile kart eşleşmesi: anahtar eşitliği
  // ya da kartın anlamlı kelimelerinin tamamının işveren metninde geçmesi
  function clientMatches(customer, clientName) {
    if (!clientName) return false;
    const ck = customerKey(clientName);
    if (ck === customer.key) return true;
    const sig = customer.key.split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
    if (sig.length < 2) return false;
    const hay = ` ${ck} `;
    return sig.every((w) => hay.includes(` ${w} `));
  }

  const crm = store.get("crm", {});
  const saveCrm = () => store.set("crm", crm);
  const crmOf = (key) => (crm[key] = crm[key] || { contacts: [], log: [] });

  let _customers = null;
  function customers() {
    if (_customers) return _customers;
    const map = new Map();
    const add = (name, origin) => {
      const key = customerKey(name);
      if (!key) return null;
      if (!map.has(key)) map.set(key, { key, name, origins: new Set() });
      map.get(key).origins.add(origin);
      return map.get(key);
    };
    tenders.forEach((t) => add(t.authority, "ihale"));
    // Sözleşme işvereni, ad farklı yazılmış olsa da mevcut bir kurumla eşleşiyorsa ayrı kart açılmaz
    deals.forEach((x) => {
      if (!x.client || map.has(customerKey(x.client))) return;
      const same = [...map.values()].some((c) => clientMatches({ key: c.key }, x.client));
      if (!same) add(x.client, "sozlesme");
    });
    Object.entries(crm).forEach(([key, c]) => { if (c.manual && !map.has(key)) map.set(key, { key, name: c.name || key, origins: new Set(["manuel"]) }); });
    _customers = [...map.values()].map((c) => {
      const data = crm[c.key] || {};
      const ts = tenders.filter((t) => customerKey(t.authority) === c.key)
        .map((t) => ({ ...t, bucket: t.isCancelled ? "cancel" : bucketOf(t.tenderDate) }))
        .sort((a, b) => new Date(a.tenderDate) - new Date(b.tenderDate));
      const cust = { ...c, displayName: data.name || titleTR(c.name), segment: data.segment || segmentOf(c.name),
        city: data.city || (ts[0] && ts[0].city) || "" };
      cust.tenders = ts;
      cust.active = ts.filter((t) => t.bucket !== "past" && t.bucket !== "cancel" && !isDismissed(t));
      cust.deals = deals.filter((x) => clientMatches(cust, x.client));
      const al = aliasesOf(c.name, data.aliases);
      cust.aliases = al;
      cust.news = news.filter((n) => mentions(`${n.title} ${n.summary}`, al));
      const dates = [...ts.map((t) => t.firstSeen || t.tenderDate), ...cust.deals.map((x) => x.date), ...cust.news.map((n) => n.publishedAt),
        ...((data.log || []).map((l) => l.date))].filter(Boolean).map((d) => new Date(d).getTime());
      cust.lastActivity = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
      cust.crm = data;
      return cust;
    });
    return _customers;
  }
  const invalidateCustomers = () => { _customers = null; };
  function nextStepState(c) {
    if (!c.nextDate) return null;
    const d = (new Date(c.nextDate + "T23:59:59") - Date.now()) / DAY;
    return d < 0 ? "overdue" : d < 1 ? "today" : "later";
  }

  // ---------- Bileşenler ----------
  function tenderCard(t) {
    const w = state.watch[t.id];
    const status = w ? STATUSES.find((s) => s.id === w.status) : null;
    return `
      <article class="t-card" data-open="${esc(t.id)}" style="--c: var(--${t.bucket === "past" || t.bucket === "cancel" ? "past" : t.bucket})">
        <div class="top">
          <button class="star ${w ? "on" : ""}" data-star="${esc(t.id)}" title="${w ? "Takipten çıkar" : "Takibe al"}" aria-label="${w ? "Takipten çıkar" : "Takibe al"}" type="button">${w ? "★" : "☆"}</button>
          <span class="badge src-${esc(t.sourceType)}">${esc(SOURCE_TYPES[t.sourceType] || t.sourceType)}</span>
          ${newIds.has(t.id) ? `<span class="badge new">YENİ</span>` : ""}
          ${t.isCancelled ? `<span class="badge warn">İPTAL</span>` : t.isAddendum ? `<span class="badge warn">Zeyilname</span>` : ""}
          ${status ? `<span class="badge status">${esc(status.label)}</span>` : ""}
          ${t.rel.score ? `<span class="score" title="Eşleşen: ${esc(t.rel.hits.join(", "))}">● ${t.rel.score} eşleşme</span>` : ""}
          <button class="dismiss" data-dismiss="${esc(t.id)}" title="Bu ihaleyi listeden çıkar" aria-label="Listeden çıkar" type="button">✕</button>
        </div>
        <h4>${hl(t.title)}</h4>
        <div class="auth">${hl(t.authority)}</div>
        <div class="sum">${hl(t.summary)}</div>
        <div class="foot">
          <span title="${esc(t.dateKind || "İhale tarihi")}">📅 ${esc(dateLabel(t))}: ${esc(whenText(t))}</span>
          <span>📍 ${esc(t.city)}</span>
          <a class="src-link" href="${esc(t.url)}" target="_blank" rel="noopener" title="${t.ekapUrl ? "EKAP'ta aç" : "İlanı aç"}">↗ ${t.ekapUrl ? "EKAP" : "İlan"}</a>
          <span class="countdown">${esc(t.isCancelled ? "İptal" : countdown(t.tenderDate))}</span>
        </div>
      </article>`;
  }

  function lane(key, items) {
    const b = BUCKETS[key];
    return `
      <section class="lane ${key}">
        <div class="lane-head"><span class="dot"></span><h2>${b.label}</h2><span class="n">${items.length}</span></div>
        <div class="muted small" style="padding:0 4px 10px">${b.hint}</div>
        ${items.length ? items.map(tenderCard).join("") : `<div class="empty">Bu aralıkta ihale yok</div>`}
      </section>`;
  }

  function datePill(t) {
    const dt = new Date(t.tenderDate);
    return `<div class="pill-date ${t.bucket}"><b>${dt.getDate()}</b><span>${dt.toLocaleString("tr-TR", { month: "short" })}</span></div>`;
  }

  // ---------- Görünümler ----------
  const views = {
    ozet() {
      const list = filteredTenders();
      const by = (k) => list.filter((t) => t.bucket === k);
      const upcoming = list.filter((t) => t.bucket !== "past" && t.bucket !== "cancel").slice(0, 7);
      const watchCount = Object.keys(state.watch).length;
      const winners = aggregateWinners().slice(0, 6);
      const maxN = Math.max(1, ...winners.map((w) => w.count));

      return `
        <div class="page-head">
          <div><h1>${(h => h < 12 ? "Günaydın" : h < 18 ? "İyi günler" : "İyi akşamlar")(new Date().getHours())} 👋</h1><p>Otomasyon & SCADA pazarında bugün öne çıkanlar.</p></div>
          <a class="btn" href="#/ihaleler">Tüm ihaleler →</a>
        </div>
        <div class="grid kpis">
          ${[["urgent", "3 günden az kalan", "var(--urgent)"], ["week", "3–7 gün kalan", "var(--week)"], ["later", "7 günden fazla", "var(--later)"]].map(([k, l, c]) => `
            <div class="card kpi" style="--kpi:${c}" data-go="ihaleler">
              <div class="label">${l}</div><div class="value">${by(k).length}</div><div class="sub">aktif ihale</div>
            </div>`).join("")}
          <div class="card kpi" data-go="takip"><div class="label">Takip listem</div><div class="value">${watchCount}</div><div class="sub">ihale izleniyor</div></div>
          <div class="card kpi" style="--kpi:#6b34b8" data-go="piyasa"><div class="label">Son 7 gün sözleşme</div><div class="value">${deals.filter((x) => daysLeft(x.date) > -7).length}</div><div class="sub">piyasa hareketi</div></div>
        </div>
        <div class="grid two-col">
          <div class="card card-pad">
            <h3>Yaklaşan ihale takvimi <a class="small" href="#/ihaleler">Panoya git</a></h3>
            ${upcoming.length ? upcoming.map((t) => `
              <div class="list-item" data-open="${esc(t.id)}" style="cursor:pointer">
                ${datePill(t)}
                <div style="min-width:0">
                  <h4>${hl(t.title)}</h4>
                  <div class="meta">${esc(t.authority)} · <span class="badge src-${esc(t.sourceType)}">${esc(SOURCE_TYPES[t.sourceType])}</span> · <b style="color:var(--${t.bucket})">${esc(countdown(t.tenderDate))}</b></div>
                </div>
              </div>`).join("") : `<p class="muted">Yaklaşan ihale yok.</p>`}
          </div>
          <div class="grid" style="align-content:start">
            <div class="card card-pad">
              <h3>Son piyasa gelişmeleri <a class="small" href="#/piyasa">Tümü</a></h3>
              ${news.slice(0, 4).map((n) => `
                <div class="list-item"><div style="min-width:0">
                  <h4><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h4>
                  <div class="meta"><span class="type-${esc(n.type)}">●</span> ${esc(n.source)} · ${esc(relDate(n.publishedAt))}</div>
                </div></div>`).join("")}
            </div>
            <div class="card card-pad">
              <h3>En çok iş alan firmalar <a class="small" href="#/rakipler">Rakip analizi</a></h3>
              <div class="bars">
                ${winners.map((w) => `
                  <div class="row"><span class="name" title="${esc(w.name)}">${esc(w.name)}</span>
                  <div class="track"><div class="fill" style="width:${(w.count / maxN) * 100}%"></div></div>
                  <span class="val">${w.count} iş</span></div>`).join("")}
              </div>
            </div>
          </div>
        </div>`;
    },

    ihaleler() {
      const list = filteredTenders();
      const cats = [...new Set(tenders.flatMap((t) => t.categories || []))].sort((a, b) => a.localeCompare(b, "tr"));
      const cities = [...new Set(tenders.map((t) => t.city))].sort((a, b) => a.localeCompare(b, "tr"));
      const by = (k) => list.filter((t) => t.bucket === k);
      const past = by("past").reverse();
      const cancelled = by("cancel");
      const active = list.length - past.length - cancelled.length;

      return `
        <div class="page-head">
          <div><h1>İhale Panosu</h1><p>Son teklif / ihale tarihine kalan süreye göre otomatik sınıflandırılır. ${active} aktif ihale.</p></div>
          <button class="btn" data-action="export-csv" type="button">⬇ CSV (Excel)</button>
        </div>
        <div class="filters">
          ${Object.entries(SOURCE_TYPES).map(([k, l]) => `<button class="chip ${state.f.src.includes(k) ? "on" : ""}" data-src="${k}" type="button">${l}</button>`).join("")}
          <span class="sep"></span>
          <select data-filter="cat"><option value="">Tüm kategoriler</option>${cats.map((c) => `<option ${state.f.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
          <select data-filter="city"><option value="">Tüm iller</option>${cities.map((c) => `<option ${state.f.city === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
          <select data-filter="sort">
            <option value="date" ${state.f.sort === "date" ? "selected" : ""}>Sırala: İhale tarihi</option>
            <option value="score" ${state.f.sort === "score" ? "selected" : ""}>Sırala: Alaka puanı</option>
          </select>
          <button class="chip ${state.f.onlyRelevant ? "on" : ""}" data-action="toggle-relevant" type="button">Yalnızca anahtar kelime eşleşenler</button>
          ${state.f.src.length || state.f.cat || state.f.city || state.f.onlyRelevant ? `<button class="btn ghost small" data-action="clear-filters" type="button">Temizle ✕</button>` : ""}
        </div>
        <div class="board">${lane("urgent", by("urgent"))}${lane("week", by("week"))}${lane("later", by("later"))}</div>
        ${cancelled.length ? `<details class="past-wrap"><summary>İptal edilen ihaleler (${cancelled.length})</summary>
          <div class="board" style="margin-top:10px"><section class="lane past">${cancelled.map(tenderCard).join("")}</section></div></details>` : ""}
        ${past.length ? `<details class="past-wrap"><summary>Süresi geçmiş ihaleler (${past.length}) — tarihinden 3 gün sonra listeden kalkar</summary>
          <div class="board" style="margin-top:10px"><section class="lane past">${past.map(tenderCard).join("")}</section></div></details>` : ""}
        ${(() => {
          const dis = Object.entries(dismissedMap())
            .map(([id, x]) => ({ id, ...x, t: tenders.find((y) => y.id === id) }))
            .sort((a, b) => new Date(b.at) - new Date(a.at));
          return `<details class="past-wrap dismissed-wrap" ${state.openDismissed ? "open" : ""} data-toggle-dismissed>
            <summary>Listeden çıkardığım ihaleler (${dis.length})</summary>
            ${dis.length ? `<div class="card table-wrap" style="margin-top:10px"><table>
              <thead><tr><th>İhale</th><th>İdare</th><th>İhale tarihi</th><th>Çıkarıldı</th><th></th></tr></thead>
              <tbody>${dis.map((x) => `<tr>
                <td>${x.t ? `<a href="javascript:void 0" data-open="${esc(x.id)}">${esc(x.title)}</a>` : esc(x.title)}</td>
                <td class="small">${esc(x.authority || "")}</td>
                <td class="small">${x.date ? esc(fmtDate(x.date, false)) + ` <span class="muted">(${esc(countdown(x.date))})</span>` : "—"}</td>
                <td class="small">${esc(relDate(x.at))}</td>
                <td><button class="btn small" data-restore="${esc(x.id)}" type="button">↩ Geri al</button></td></tr>`).join("")}</tbody></table></div>
              <p class="muted small">Bu ihaleler ihale tarihinden 3 gün sonra buradan da otomatik silinir. Çıkardığın ihaleler için hatırlatma e-postası gönderilmez.</p>`
              : `<p class="muted small" style="margin:10px 0">Henüz listeden çıkardığın ihale yok. Kartın sağ üstündeki ✕ ile çıkarabilirsin.</p>`}
          </details>`;
        })()}`;
    },

    piyasa() {
      const tabs = `
        <div class="filters">
          <button class="chip ${state.piyasaTab === "haber" ? "on" : ""}" data-tab="haber" type="button">Haber akışı</button>
          <button class="chip ${state.piyasaTab === "sozlesme" ? "on" : ""}" data-tab="sozlesme" type="button">Sözleşmeler & İhale sonuçları</button>
        </div>`;

      if (state.piyasaTab === "sozlesme") {
        const { key, dir } = state.dealSort;
        const val = (x) => key === "amount" ? (x.amount?.amount || 0) : key === "estimate" ? (x.estimate?.amount || 0)
          : key === "discount" ? (discountOf(x) ?? -1) : key === "bidders" ? (x.bidders ?? -1)
          : key === "date" ? new Date(x.date) : String(x[key] || "");
        const rows = deals
          .filter((x) => matchesQuery(x, ["winner", "client", "subject", "sector", "source", "ikn"]))
          .sort((a, b) => { const va = val(a), vb = val(b); return (va > vb ? 1 : va < vb ? -1 : 0) * dir; });
        const th = (k, l, title = "") => `<th data-sort="${k}" title="${title}">${l}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
        return `
          <div class="page-head"><div><h1>Piyasa & Sözleşmeler</h1><p>Hangi firma, hangi işi, kaça aldı? Her satır kaynak habere, İKN varsa EKAP kaydına bağlanır.</p></div></div>
          ${tabs}
          <div class="card table-wrap">
            <table>
              <thead><tr>${th("date", "Tarih")}${th("winner", "Yüklenici")}${th("client", "İşveren")}${th("subject", "İş")}${th("sector", "Sektör")}${th("amount", "Sözleşme bedeli")}${th("estimate", "Yaklaşık maliyet")}${th("discount", "Kırım", "Yaklaşık maliyete göre indirim oranı")}${th("bidders", "Teklif")}<th>Kaynak</th></tr></thead>
              <tbody>${rows.map((x) => {
                const disc = discountOf(x);
                return `
                <tr><td>${esc(fmtDate(x.date, false))}</td><td><b>${hl(x.winner)}</b><div class="muted small">${esc(x.type || "")}</div></td>
                <td>${x.client ? `<a href="#/musteri/${encodeURIComponent(customerKey(x.client))}">${hl(x.client)}</a>` : `<span class="muted">—</span>`}</td><td>${hl(x.subject)}</td>
                <td><span class="tag">${esc(x.sector)}</span></td><td class="num">${esc(fmtMoney(x.amount))}</td><td class="num muted">${esc(fmtMoney(x.estimate))}</td>
                <td class="num">${disc == null ? "—" : `%${disc.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`}</td>
                <td class="num">${x.bidders ?? "—"}</td>
                <td class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source)} ↗</a>${x.ekapUrl ? `<br><a href="${esc(x.ekapUrl)}" target="_blank" rel="noopener">EKAP ${esc(x.ikn)} ↗</a>` : ""}</td></tr>`;
              }).join("") || `<tr><td colspan="10" class="muted">Sonuç yok.</td></tr>`}</tbody>
            </table>
          </div>
          <p class="muted small">Veriler Yatırımlar Dergisi'nin herkese açık haberlerinden otomatik ayrıştırılır; her taramada yeni sözleşmeler geçmişe eklenir. Kırım = (yaklaşık maliyet − sözleşme bedeli) / yaklaşık maliyet.</p>`;
      }

      const types = { "": "Tümü", sozlesme: "Sözleşme / Kazanan", sonuc: "İhale sonucu", ihale: "İhale duyurusu", yatirim: "Yatırım / Mevzuat", haber: "Sektör haberi" };
      const items = news
        .filter((n) => !state.newsType || n.type === state.newsType)
        .filter((n) => !state.newsRelevant || newsRelevant(n))
        .filter((n) => matchesQuery(n, ["title", "summary", "source", "tags"]));
      return `
        <div class="page-head"><div><h1>Piyasa & Sözleşmeler</h1><p>Yatırımlar Dergisi, Enerji Günlüğü, YeniEnerji ve Google Haberler'den derlenir — başlığa tıklayınca haberin kendisi açılır.</p></div></div>
        ${tabs}
        <div class="filters">${Object.entries(types).map(([k, l]) => `<button class="chip ${state.newsType === k ? "on" : ""}" data-newstype="${k}" type="button">${l}</button>`).join("")}
          <span class="sep"></span><button class="chip ${state.newsRelevant ? "on" : ""}" data-action="toggle-news-relevant" type="button">Yalnızca enerji / otomasyon</button></div>
        <div class="news-grid">
          ${items.map((n) => `
            <article class="card news-card">
              <div class="small type-${esc(n.type)}"><b>${esc(types[n.type] || n.type)}</b></div>
              <h4><a href="${esc(n.url)}" target="_blank" rel="noopener">${hl(n.title)}</a></h4>
              ${n.summary ? `<p>${hl(n.summary)}</p>` : ""}
              <div class="meta">${esc(n.source)}${n.via ? ` <span class="muted">(${esc(n.via)})</span>` : ""} · ${esc(relDate(n.publishedAt))} ${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
            </article>`).join("") || `<p class="muted">Sonuç yok.</p>`}
        </div>`;
    },

    takip() {
      const watched = tenders
        .filter((t) => state.watch[t.id] && listable(t))
        .map((t) => ({ ...t, bucket: bucketOf(t.tenderDate), rel: relevance(t) }))
        .sort((a, b) => new Date(a.tenderDate) - new Date(b.tenderDate));
      return `
        <div class="page-head"><div><h1>Takip Listem</h1><p>İhaleleri teklif sürecine göre yönet. Durumu kart detayından değiştirebilirsin.</p></div>
          ${watched.length ? `<button class="btn" data-action="export-ics-all" type="button">📅 Tümünü takvime aktar (.ics)</button>` : ""}</div>
        ${watched.length ? `<div class="pipeline">
          ${STATUSES.map((s) => {
            const items = watched.filter((t) => state.watch[t.id].status === s.id);
            return `<section class="lane" style="--c:var(--accent);--c-soft:var(--accent-soft)">
              <div class="lane-head"><h2>${s.label}</h2><span class="n">${items.length}</span></div>
              ${items.map(tenderCard).join("") || `<div class="empty">—</div>`}
            </section>`;
          }).join("")}
        </div>` : `<div class="card card-pad"><p>Henüz takip ettiğin ihale yok. İhale kartlarındaki <b>☆</b> ile ekleyebilirsin.</p></div>`}`;
    },

    rakipler() {
      const pinned = new Set(prefs().rivals || []);
      const rows = aggregateWinners()
        .filter((r) => !state.q || matchesQuery({ n: r.name, c: [...r.clients].join(" "), s: [...r.sectors].join(" ") }, ["n", "c", "s"]))
        .sort((a, b) => (pinned.has(b.name) ? 1 : 0) - (pinned.has(a.name) ? 1 : 0));
      const top = rows.filter((r) => r.tryTotal).slice(0, 10);
      return `
        <div class="page-head"><div><h1>Rakip Analizi</h1><p>Sözleşme ve ihale sonuçlarından otomatik çıkarılır: kim, hangi sektörde, hangi işverenle, kaça çalışıyor? Firmaya tıklayınca profili açılır.</p></div></div>
        <div class="grid two-col" style="margin-bottom:16px">
          <div class="card card-pad"><h3>En çok sözleşme bedeli alan firmalar (₺)</h3>
            ${barList(top.map((r) => [r.name, r.tryTotal, `${r.name}: ${fmtMoney({ amount: r.tryTotal, currency: "TRY" })} · ${r.count} iş`, `#/rakip/${encodeURIComponent(r.name)}`]), (v) => fmtMoney({ amount: v, currency: "TRY" }))}
          </div>
          <div class="card card-pad"><h3>Özet</h3>
            ${statTiles([["Firma", fmtNum(rows.length)], ["Sözleşme", fmtNum(deals.length)],
              ["Toplam (₺)", esc(fmtMoney({ amount: deals.reduce((a, x) => a + tryAmount(x), 0), currency: "TRY" }))],
              ["Ort. kırım", (() => { const d = deals.map(discountOf).filter((v) => v != null); return d.length ? "%" + fmtNum(d.reduce((a, b) => a + b, 0) / d.length, 1) : "—"; })()]])}
            <p class="muted small" style="margin:10px 0 0">${dataNote}</p>
          </div>
        </div>
        <div class="card table-wrap">
          <table>
            <thead><tr><th></th><th>Firma</th><th>İş</th><th>Toplam bedel</th><th>Ort. kırım</th><th>Ort. teklif</th><th>Sektörler</th><th>İşverenler</th><th>Son iş</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr><td>${pinned.has(r.name) ? "📌" : ""}</td><td><a href="#/rakip/${encodeURIComponent(r.name)}"><b>${hl(r.name)}</b></a></td><td class="num">${r.count}</td>
              <td class="num">${Object.entries(r.totals).map(([c, a]) => esc(fmtMoney({ amount: a, currency: c }))).join("<br>") || "—"}</td>
              <td class="num">${r.avgDiscount == null ? "—" : "%" + fmtNum(r.avgDiscount, 1)}</td>
              <td class="num">${r.avgBidders == null ? "—" : fmtNum(r.avgBidders, 1)}</td>
              <td>${[...r.sectors].map((s) => `<span class="tag">${esc(s)}</span>`).join(" ")}</td>
              <td class="small">${[...r.clients].map(esc).join("<br>") || "—"}</td>
              <td>${esc(relDate(r.last))}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">Henüz sözleşme verisi yok.</td></tr>`}</tbody>
          </table>
        </div>`;
    },

    rakip() {
      const r = aggregateWinners().find((x) => x.name === state.param);
      if (!r) return `<p>Firma bulunamadı. <a href="#/rakipler">Rakip listesine dön</a></p>`;
      const pinned = (prefs().rivals || []).includes(r.name);
      const words = customerKey(r.name).split(" ").filter((w) => w.length >= 3 && !/^(İNŞAAT|SANAYİ|TİCARET|ANONİM|ŞİRKETİ|LİMİTED|ORTAKLIĞI|MÜHENDİSLİK|VE|İŞ)$/.test(w)).slice(0, 2);
      const mentions = words.length ? news.filter((n) => { const h = customerKey(`${n.title} ${n.summary || ""}`); return words.every((w) => h.includes(w)); }) : [];
      const byClient = sumBy(r.deals, (x) => x.client || "Belirtilmemiş", tryAmount);
      const bySector = countBy(r.deals, (x) => x.sector);
      const list = r.deals.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
      return `
        <div class="page-head">
          <div><a class="small" href="#/rakipler">← Rakip analizi</a><h1 style="margin-top:6px">${esc(r.name)}</h1>
            <p>${[...r.sectors].map((s) => `<span class="tag">${esc(s)}</span>`).join(" ")} · Son iş: ${esc(relDate(r.last))}</p></div>
          <button class="btn ${pinned ? "on" : ""}" data-action="pin-rival" data-name="${esc(r.name)}" type="button">${pinned ? "📌 Takipte" : "📌 Rakibi takip et"}</button>
        </div>
        ${statTiles([["Sözleşme", fmtNum(r.count)], ["Toplam bedel", Object.entries(r.totals).map(([c, a]) => esc(fmtMoney({ amount: a, currency: c }))).join(" + ") || "—"],
          ["Ort. kırım", r.avgDiscount == null ? "—" : "%" + fmtNum(r.avgDiscount, 1), "yaklaşık maliyete göre indirim"],
          ["Ort. teklif sayısı", r.avgBidders == null ? "—" : fmtNum(r.avgBidders, 1), "ihalelerdeki rekabet"]])}
        <div class="grid two-col" style="margin-top:16px">
          <div class="card card-pad"><h3>İşverenlere göre sözleşme bedeli (₺)</h3>
            ${barList(byClient.map(([c, v]) => [c, v, `${c}: ${fmtMoney({ amount: v, currency: "TRY" })}`, c !== "Belirtilmemiş" ? `#/musteri/${encodeURIComponent(customerKey(c))}` : ""]), (v) => fmtMoney({ amount: v, currency: "TRY" }))}</div>
          <div class="card card-pad"><h3>Sektörlere göre iş sayısı</h3>${barList(bySector.map(([s, n]) => [s, n]), (v) => `${v} iş`)}</div>
        </div>
        <div class="card table-wrap" style="margin-top:16px">
          <table><thead><tr><th>Tarih</th><th>İşveren</th><th>İş</th><th>Bedel</th><th>Yaklaşık maliyet</th><th>Kırım</th><th>Teklif</th><th>Kaynak</th></tr></thead>
          <tbody>${list.map((x) => `<tr><td>${esc(fmtDate(x.date, false))}</td><td>${esc(x.client || "—")}</td><td>${esc(x.subject)}</td>
            <td class="num">${esc(fmtMoney(x.amount))}</td><td class="num muted">${esc(fmtMoney(x.estimate))}</td>
            <td class="num">${discountOf(x) == null ? "—" : "%" + fmtNum(discountOf(x), 1)}</td><td class="num">${x.bidders ?? "—"}</td>
            <td class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source)} ↗</a>${x.ekapUrl ? `<br><a href="${esc(x.ekapUrl)}" target="_blank" rel="noopener">EKAP ↗</a>` : ""}</td></tr>`).join("")}</tbody></table>
        </div>
        <div class="card card-pad" style="margin-top:16px"><h3>Adının geçtiği haberler <span class="muted small">${mentions.length}</span></h3>
          ${mentions.slice(0, 20).map((n) => `<div class="list-item"><div><h4 style="font-weight:500"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h4><div class="meta">${esc(n.source)} · ${esc(relDate(n.publishedAt))}</div></div></div>`).join("") || `<p class="muted small">Eşleşen haber yok.</p>`}
          <p class="muted small">Takip ettiğin rakiplerin yeni haberleri Sabah Özeti'nde ayrıca listelenir.</p>
        </div>`;
    },

    kurumlar() {
      const f = state.instFilter;
      const all = customers().filter((c) => c.tenders.length || c.deals.length);
      const cities = [...new Set(all.map((c) => c.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "tr"));
      const segs = [...new Set(all.map((c) => c.segment))];
      const enrich = (c) => {
        const dealsTry = c.deals.reduce((a, x) => a + tryAmount(x), 0);
        const priced = c.deals.filter((x) => tryAmount(x));
        return { ...c, n: c.tenders.length, dealsTry, avgDeal: priced.length ? dealsTry / priced.length : null,
          lastTender: c.tenders.length ? c.tenders[c.tenders.length - 1].tenderDate : null };
      };
      // Potansiyel müşteri = alanımızda ihale açan kurum: önce ilgili ihale sayısı, sonra bilinen sözleşme bedeli
      const rank = (a, b) => b.n - a.n || b.dealsTry - a.dealsTry || b.active.length - a.active.length;
      const scoped = all.filter((c) => (!f.il || c.city === f.il) && (!f.seg || c.segment === f.seg)).map(enrich).sort(rank);
      const withTenders = scoped.filter((c) => c.n > 0);
      const top = (withTenders.length ? withTenders : scoped).slice(0, f.top || 7);
      // İl bazında: her ilin en çok (bilinen) bütçeli / en çok ihale açan ilk 3 kurumu
      const byCity = cities.map((il) => ({ il, list: all.filter((c) => c.city === il && (!f.seg || c.segment === f.seg)).map(enrich).sort(rank) }))
        .filter((x) => x.list.length).sort((a, b) => b.list.reduce((s, c) => s + c.n, 0) - a.list.reduce((s, c) => s + c.n, 0));
      // Kurum → yüklenici tablosu
      const pairs = sumBy(deals.filter((x) => x.client), (x) => `${x.client}␟${x.winner}`, (x) => tryAmount(x) || 0.000001)
        .map(([k, v]) => { const [client, winner] = k.split("␟"); const ds = deals.filter((x) => x.client === client && x.winner === winner); return { client, winner, total: Math.round(v), n: ds.length }; });
      const months = lastMonths(12);

      const card = (c, i) => {
        // İlan ayı: yayın tarihi saklanmadığı için ihalenin radara ilk düştüğü tarih (yoksa ihale tarihi)
        const monthly = months.map((m) => ({ key: m, label: monthLabel(m), value: c.tenders.filter((t) => monthKey(t.firstSeen || t.tenderDate) === m).length }));
        const spendM = months.map((m) => ({ key: m, label: monthLabel(m), value: c.deals.filter((x) => monthKey(x.date) === m).reduce((a, x) => a + tryAmount(x), 0) }));
        const years = sumBy(c.deals, (x) => String(new Date(x.date).getFullYear()), tryAmount);
        const types = countBy(c.tenders, typeOf);
        const topics = countBy(c.tenders.flatMap(topicOf), (x) => x);
        const winners = sumBy(c.deals, (x) => x.winner, (x) => tryAmount(x) || 0.000001);
        return `
          <div class="card card-pad inst-card">
            <div class="inst-head"><span class="rank">${i + 1}</span><div style="min-width:0"><h3 style="margin:0"><a href="#/musteri/${encodeURIComponent(c.key)}">${esc(c.displayName)}</a></h3>
              <div class="muted small">${esc(c.segment)}${c.city ? " · " + esc(c.city) : ""}</div></div></div>
            ${statTiles([["İhale", fmtNum(c.n), `${c.active.length} aktif`], ["Bilinen sözleşme", c.dealsTry ? esc(fmtMoney({ amount: c.dealsTry, currency: "TRY" })) : "—", c.deals.length ? `${c.deals.length} sözleşme${c.dealsTry ? "" : " (bedel açıklanmamış)"}` : "sözleşme haberi yok"],
              ["Ort. sözleşme", c.avgDeal ? esc(fmtMoney({ amount: c.avgDeal, currency: "TRY" })) : "—"], ["Son ihale", c.lastTender ? esc(fmtDate(c.lastTender, false)) : "—"]])}
            <div class="grid two-col" style="margin-top:12px">
              <div><h4 class="chart-title">Aylık ihale sayısı (ilan ayı, son 12 ay)</h4>${columnChart(monthly, (v) => `${v} ihale`)}</div>
              <div><h4 class="chart-title">Aylık bilinen harcama (₺, son 12 ay)</h4>${columnChart(spendM, (v) => fmtMoney({ amount: v, currency: "TRY" }))}</div>
              <div><h4 class="chart-title">Alım türleri</h4>${barList(types.map(([k, v]) => [k, v]), (v) => `${v} ihale`)}</div>
              <div><h4 class="chart-title">İlgilendiği konular</h4>${barList(topics.slice(0, 6).map(([k, v]) => [k, v]), (v) => `${v} ihale`)}</div>
              <div><h4 class="chart-title">İşlerini alan firmalar</h4>${barList(winners.slice(0, 6).map(([k, v]) => [k, Math.round(v), `${k}: ${v >= 1 ? fmtMoney({ amount: v, currency: "TRY" }) : "bedel açıklanmamış"}`, `#/rakip/${encodeURIComponent(k)}`]), (v) => (v >= 1 ? fmtMoney({ amount: v, currency: "TRY" }) : "—"))}</div>
              <div><h4 class="chart-title">Yıllara göre bilinen harcama</h4>${barList(years.map(([k, v]) => [k, v]), (v) => fmtMoney({ amount: v, currency: "TRY" }))}</div>
            </div>
          </div>`;
      };

      return `
        <div class="page-head"><div><h1>Kurum Analitiği</h1><p>Potansiyel müşterilerin ihale hacmi, alım türleri, harcamaları ve işlerini alan firmalar.</p></div></div>
        <div class="banner-note">ⓘ ${dataNote} EKAP sonuç verisi (tüm sözleşme bedelleri) bağlanana kadar harcama tutarları eksik kalır.</div>
        <div class="filters">
          <select data-inst="il"><option value="">Tüm iller</option>${cities.map((c) => `<option ${f.il === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
          <select data-inst="seg"><option value="">Tüm segmentler</option>${segs.map((s) => `<option ${f.seg === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
          <select data-inst="top">${[7, 10, 15, 20].map((n) => `<option value="${n}" ${(f.top || 7) === n ? "selected" : ""}>İlk ${n} kurum</option>`).join("")}</select>
          <span class="muted small">${scoped.length} kurum</span>
        </div>
        <h2 class="section-title">İlk ${top.length} kurum${f.il ? " — " + esc(f.il) : ""}</h2>
        <div class="inst-grid">${top.map(card).join("") || `<p class="muted">Bu filtrede kurum yok.</p>`}</div>

        <h2 class="section-title">İl bazında en çok bütçeli / en aktif kurumlar</h2>
        <div class="card table-wrap"><table>
          <thead><tr><th>İl</th><th>Kurum</th><th>İhale</th><th>Aktif</th><th>Bilinen sözleşme (₺)</th><th>Ort. sözleşme</th><th>Alım türleri</th></tr></thead>
          <tbody>${byCity.map(({ il, list }) => list.slice(0, 3).map((c, j) => `<tr>
            ${j === 0 ? `<td rowspan="${Math.min(3, list.length)}"><b>${esc(il)}</b><div class="muted small">${list.length} kurum</div></td>` : ""}
            <td><a href="#/musteri/${encodeURIComponent(c.key)}">${esc(c.displayName)}</a></td><td class="num">${c.n}</td><td class="num">${c.active.length}</td>
            <td class="num">${c.dealsTry ? esc(fmtMoney({ amount: c.dealsTry, currency: "TRY" })) : "—"}</td><td class="num">${c.avgDeal ? esc(fmtMoney({ amount: c.avgDeal, currency: "TRY" })) : "—"}</td>
            <td class="small">${countBy(c.tenders, typeOf).map(([k, v]) => `${esc(k)} (${v})`).join(", ")}</td></tr>`).join("")).join("") || `<tr><td colspan="7" class="muted">Veri yok.</td></tr>`}</tbody>
        </table></div>

        <h2 class="section-title">Kurumların ihalelerini alan firmalar</h2>
        <div class="card table-wrap"><table>
          <thead><tr><th>İşveren kurum</th><th>Yüklenici</th><th>İş sayısı</th><th>Toplam sözleşme</th></tr></thead>
          <tbody>${pairs.map((p) => `<tr><td><a href="#/musteri/${encodeURIComponent(customerKey(p.client))}">${esc(p.client)}</a></td>
            <td><a href="#/rakip/${encodeURIComponent(p.winner)}">${esc(p.winner)}</a></td><td class="num">${p.n}</td>
            <td class="num">${p.total >= 1 ? esc(fmtMoney({ amount: p.total, currency: "TRY" })) : "—"}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Henüz sözleşme verisi yok.</td></tr>`}</tbody>
        </table></div>`;
    },

    harita() {
      const f = state.mapFilter;
      const metrics = { active: "Aktif ihale sayısı", all: "Tüm ihaleler (geçmiş dahil)", inst: "Kurum sayısı (potansiyel müşteri)", deals: "Bilinen sözleşme bedeli (₺)" };
      return `
        <div class="page-head"><div><h1>İhale Haritası</h1><p>Potansiyel müşterilerin ve ihalelerin illere göre yoğunluğu. Bir ile tıklayınca kurumları ve ihaleleri listelenir.</p></div></div>
        <div class="filters">
          <select data-map="metric">${Object.entries(metrics).map(([k, l]) => `<option value="${k}" ${f.metric === k ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select data-map="seg"><option value="">Tüm segmentler</option>${SEGMENTS.map((s) => `<option ${f.seg === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
        </div>
        <div class="map-layout">
          <div class="card card-pad"><div id="trMap" class="tr-map"><p class="muted small">Harita yükleniyor…</p></div><div id="mapLegend" class="map-legend"></div></div>
          <div class="card card-pad" id="mapSide"><p class="muted small">Ayrıntı için haritada bir il seç.</p></div>
        </div>
        <details class="card card-pad" style="margin-top:16px"><summary><b>Tablo görünümü</b></summary><div id="mapTable" class="table-wrap"></div></details>`;
    },

    musteriler() {
      const all = customers();
      const f = state.custFilter;
      const list = all
        .filter((c) => !f.seg || c.segment === f.seg)
        .filter((c) => !f.pinned || c.crm.pinned)
        .filter((c) => !state.q || matchesQuery({ n: c.displayName, a: c.aliases.join(" "), s: c.segment, c: c.city }, ["n", "a", "s", "c"]))
        .sort((a, b) => f.sort === "name" ? a.displayName.localeCompare(b.displayName, "tr")
          : f.sort === "recent" ? new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0)
          : (b.crm.pinned ? 1 : 0) - (a.crm.pinned ? 1 : 0) || b.active.length - a.active.length || b.tenders.length - a.tenders.length);
      const segCounts = SEGMENTS.map((s) => [s, all.filter((c) => c.segment === s).length]).filter(([, n]) => n);
      const actions = all.filter((c) => ["overdue", "today"].includes(nextStepState(c.crm)));
      return `
        <div class="page-head">
          <div><h1>Müşteri Kartları</h1><p>İhale açan idareler ve sözleşme işverenlerinden otomatik oluşur; kişi, görüşme ve sonraki adım bilgilerini sen eklersin.</p></div>
          <button class="btn primary" data-crm="show-add" type="button">+ Müşteri ekle</button>
        </div>
        <form class="card card-pad" data-crm-form="add-customer" ${state.showAddCustomer ? "" : "hidden"} style="margin-bottom:16px">
          <h3>Yeni müşteri (ör. özel sektör firması)</h3>
          <div class="form-row">
            <input class="input" name="name" placeholder="Firma / kurum adı" required>
            <select name="segment">${SEGMENTS.map((s) => `<option ${s === "Özel sektör" ? "selected" : ""}>${s}</option>`).join("")}</select>
            <input class="input" name="city" placeholder="İl">
            <button class="btn primary" type="submit">Kaydet</button>
          </div>
        </form>
        ${actions.length ? `<div class="card card-pad" style="margin-bottom:16px;border-left:4px solid var(--urgent)"><h3>Bugün / gecikmiş aksiyonlar</h3>
          ${actions.map((c) => `<div class="list-item"><div><h4><a href="#/musteri/${encodeURIComponent(c.key)}">${esc(c.displayName)}</a></h4>
            <div class="meta"><b style="color:var(--urgent)">${esc(fmtDate(c.crm.nextDate, false))}</b> · ${esc(c.crm.nextStep || "Sonraki adım")}</div></div></div>`).join("")}</div>` : ""}
        <div class="filters">
          <button class="chip ${!f.seg ? "on" : ""}" data-seg="" type="button">Tümü (${all.length})</button>
          ${segCounts.map(([s, n]) => `<button class="chip ${f.seg === s ? "on" : ""}" data-seg="${esc(s)}" type="button">${esc(s)} (${n})</button>`).join("")}
          <span class="sep"></span>
          <button class="chip ${f.pinned ? "on" : ""}" data-crm="toggle-pinned-filter" type="button">📌 Takip ettiklerim</button>
          <select data-custsort>
            <option value="active" ${f.sort === "active" ? "selected" : ""}>Sırala: Aktif ihale</option>
            <option value="recent" ${f.sort === "recent" ? "selected" : ""}>Sırala: Son hareket</option>
            <option value="name" ${f.sort === "name" ? "selected" : ""}>Sırala: Ad</option>
          </select>
        </div>
        <div class="cust-grid">
          ${list.map((c) => {
            const ns = nextStepState(c.crm);
            return `
            <a class="card cust-card" href="#/musteri/${encodeURIComponent(c.key)}">
              <div class="top"><span class="badge">${esc(c.segment)}</span>${c.city ? `<span class="muted small">📍 ${esc(c.city)}</span>` : ""}
                ${c.crm.pinned ? `<span style="margin-left:auto">📌</span>` : ""}</div>
              <h4>${esc(c.displayName)}</h4>
              <div class="stats">
                <div><b style="color:${c.active.length ? "var(--accent)" : "inherit"}">${c.active.length}</b><span>aktif ihale</span></div>
                <div><b>${c.tenders.length}</b><span>toplam ihale</span></div>
                <div><b>${c.deals.length}</b><span>sözleşme</span></div>
                <div><b>${c.news.length}</b><span>haber</span></div>
              </div>
              <div class="muted small">${c.crm.nextStep ? `<span class="${ns === "overdue" ? "txt-urgent" : ""}">➜ ${esc(c.crm.nextStep)}${c.crm.nextDate ? ` · ${esc(fmtDate(c.crm.nextDate, false))}` : ""}</span>`
                : c.lastActivity ? `Son hareket: ${esc(relDate(c.lastActivity))}` : ""}</div>
            </a>`;
          }).join("") || `<p class="muted">Sonuç yok.</p>`}
        </div>`;
    },

    musteri() {
      const c = customers().find((x) => x.key === state.param);
      if (!c) return `<p>Müşteri bulunamadı. <a href="#/musteriler">Listeye dön</a></p>`;
      const d = c.crm;
      const k = esc(c.key);
      const past = c.tenders.filter((t) => t.bucket === "past" || t.bucket === "cancel").reverse();
      const ns = nextStepState(d);
      return `
        <div class="page-head">
          <div><a class="small" href="#/musteriler">← Müşteri kartları</a>
            <h1 style="margin-top:6px">${esc(c.displayName)}</h1>
            <p><span class="badge">${esc(c.segment)}</span> ${c.city ? `· 📍 ${esc(c.city)}` : ""} · Son hareket: ${c.lastActivity ? esc(relDate(c.lastActivity)) : "—"}</p></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn ${d.pinned ? "on" : ""}" data-crm="pin" data-key="${k}" type="button">${d.pinned ? "📌 Takipte" : "📌 Takibe al"}</button>
            ${d.manual ? `<button class="btn ghost" data-crm="delete-customer" data-key="${k}" type="button">Sil</button>` : ""}
          </div>
        </div>
        <div class="grid cust-detail">
          <div class="grid" style="align-content:start">
            <div class="card card-pad"><h3>Aktif ihaleler <span class="muted small">${c.active.length}</span></h3>
              ${c.active.map((t) => `
                <div class="list-item" data-open="${esc(t.id)}" style="cursor:pointer">${datePill(t)}
                  <div style="min-width:0"><h4>${esc(t.title)}</h4>
                  <div class="meta">${esc(t.dateKind || "İhale tarihi")}: ${esc(whenText(t))} · <b style="color:var(--${t.bucket})">${esc(countdown(t.tenderDate))}</b>
                  ${t.ekapUrl ? ` · <a href="${esc(t.ekapUrl)}" target="_blank" rel="noopener">EKAP ↗</a>` : ""} · <a href="${esc(t.ilanUrl || t.url)}" target="_blank" rel="noopener">İlan ↗</a></div></div>
                </div>`).join("") || `<p class="muted small">Şu an açık ihalesi yok.</p>`}
            </div>
            ${past.length ? `<div class="card card-pad"><h3>Geçmiş ihaleler <span class="muted small">${past.length}</span></h3>
              ${past.map((t) => `<div class="list-item"><div style="min-width:0"><h4 style="font-weight:500">${esc(t.title)} ${t.isCancelled ? `<span class="badge warn">İPTAL</span>` : ""}</h4>
                <div class="meta">${esc(fmtDate(t.tenderDate, false))} · ${esc(refOf(t))} · <a href="${esc(t.url)}" target="_blank" rel="noopener">Kaynak ↗</a></div></div></div>`).join("")}</div>` : ""}
            <div class="card card-pad"><h3>Sözleşmeler / ihale sonuçları <span class="muted small">${c.deals.length}</span></h3>
              ${c.deals.map((x) => `<div class="list-item"><div style="min-width:0"><h4>${esc(x.subject)}</h4>
                <div class="meta"><b>${esc(x.winner)}</b> · ${esc(fmtMoney(x.amount))}${discountOf(x) != null ? ` · kırım %${discountOf(x)}` : ""}${x.bidders ? ` · ${x.bidders} teklif` : ""} · ${esc(fmtDate(x.date, false))} · <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source)} ↗</a></div></div></div>`).join("")
                || `<p class="muted small">Bu işverene ait sözleşme haberi henüz yok.</p>`}
            </div>
            <div class="card card-pad"><h3>Haberler <span class="muted small">${c.news.length}</span></h3>
              ${c.news.slice(0, 15).map((n) => `<div class="list-item"><div style="min-width:0"><h4 style="font-weight:500"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h4>
                <div class="meta">${esc(n.source)} · ${esc(relDate(n.publishedAt))}</div></div></div>`).join("")
                || `<p class="muted small">Eşleşen haber yok. Sağdaki "Diğer adları" alanına kısaltma ekleyerek eşleşmeyi genişletebilirsin.</p>`}
              <div class="muted small">Aranan adlar: ${c.aliases.map(esc).join(", ")}</div>
            </div>
          </div>

          <div class="grid" style="align-content:start">
            <div class="card card-pad" ${ns === "overdue" ? `style="border-left:4px solid var(--urgent)"` : ""}><h3>Sonraki adım</h3>
              <input class="input full" data-crm-field="nextStep" data-key="${k}" value="${esc(d.nextStep || "")}" placeholder="ör. Teknik müdürle SCADA Faz-10 ön görüşmesi">
              <div class="form-row" style="margin-top:8px">
                <input class="input" type="date" data-crm-field="nextDate" data-key="${k}" value="${esc(d.nextDate || "")}">
                <select data-crm-field="potential" data-key="${k}">
                  ${["", "Yüksek", "Orta", "Düşük"].map((p) => `<option value="${p}" ${d.potential === p ? "selected" : ""}>${p ? "Potansiyel: " + p : "Potansiyel seç"}</option>`).join("")}
                </select>
                ${d.nextDate ? `<button class="btn small" data-crm="ics" data-key="${k}" type="button">📅</button>` : ""}
              </div>
              ${ns === "overdue" ? `<div class="small txt-urgent" style="margin-top:6px">Tarihi geçti!</div>` : ""}
            </div>
            <div class="card card-pad"><h3>Kişiler</h3>
              ${(d.contacts || []).map((p, i) => `<div class="contact"><div><b>${esc(p.name)}</b> ${p.title ? `<span class="muted">· ${esc(p.title)}</span>` : ""}
                <div class="small">${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ""} ${p.email ? ` · <a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ""}</div></div>
                <button class="btn ghost small" data-crm="del-contact" data-key="${k}" data-i="${i}" type="button">×</button></div>`).join("") || `<p class="muted small">Henüz kişi yok.</p>`}
              <form class="stack" data-crm-form="contact" data-key="${k}">
                <input class="input" name="name" placeholder="Ad soyad" required>
                <input class="input" name="title" placeholder="Ünvan (ör. SCADA Müdürü)">
                <div class="form-row"><input class="input" name="phone" placeholder="Telefon"><input class="input" name="email" type="email" placeholder="E-posta"></div>
                <button class="btn" type="submit">+ Kişi ekle</button>
              </form>
            </div>
            <div class="card card-pad"><h3>Görüşme kaydı</h3>
              <form class="stack" data-crm-form="log" data-key="${k}">
                <div class="form-row">
                  <input class="input" type="date" name="date" value="${new Date().toISOString().slice(0, 10)}">
                  <select name="type">${["Görüşme", "Toplantı", "E-posta", "Saha ziyareti", "Teklif", "Diğer"].map((x) => `<option>${x}</option>`).join("")}</select>
                </div>
                <textarea class="input" name="text" placeholder="Ne konuşuldu, sonuç, ihtiyaçlar…" required></textarea>
                <button class="btn" type="submit">+ Kaydet</button>
              </form>
              ${(d.log || []).slice().sort((a, b) => b.date.localeCompare(a.date)).map((l) => `
                <div class="log-item"><div class="muted small"><b>${esc(l.type)}</b> · ${esc(fmtDate(l.date, false))}
                  <button class="btn ghost small" data-crm="del-log" data-key="${k}" data-id="${esc(l.id)}" type="button">×</button></div>
                  <div>${esc(l.text).replace(/\n/g, "<br>")}</div></div>`).join("")}
            </div>
            <div class="card card-pad"><h3>Notlar</h3>
              <textarea class="input" data-crm-field="notes" data-key="${k}" placeholder="Kurulu sistemler, marka tercihleri, bütçe dönemi, rakip ilişkileri…">${esc(d.notes || "")}</textarea>
              <h3 style="margin-top:14px">Diğer adları / kısaltmalar</h3>
              <input class="input full" data-crm-field="aliases" data-key="${k}" value="${esc(d.aliases || "")}" placeholder="ör. UEDAŞ, Uludağ EDAŞ">
              <div class="form-row" style="margin-top:8px">
                <select data-crm-field="segment" data-key="${k}">${SEGMENTS.map((s) => `<option ${c.segment === s ? "selected" : ""}>${s}</option>`).join("")}</select>
                <input class="input" data-crm-field="city" data-key="${k}" value="${esc(c.city)}" placeholder="İl">
              </div>
            </div>
          </div>
        </div>`;
    },

    sabah() {
      const now = Date.now();
      const all = tenders.filter((t) => listable(t) && relevance(t).score >= 0).map((t) => ({ ...t, bucket: t.isCancelled ? "cancel" : bucketOf(t.tenderDate) }));
      const live = all.filter((t) => t.bucket !== "past" && t.bucket !== "cancel");
      const in2 = live.filter((t) => daysLeft(t.tenderDate) < 2).sort((a, b) => new Date(a.tenderDate) - new Date(b.tenderDate));
      const since = now - 26 * 3600000;
      const fresh = live.filter((t) => t.firstSeen && new Date(t.firstSeen) >= since && !in2.includes(t));
      const week = live.filter((t) => t.bucket === "week" && !in2.includes(t));
      const watched = live.filter((t) => state.watch[t.id]);
      const newDeals = deals.filter((x) => now - new Date(x.date) < 3 * DAY);
      const topNews = news.filter((n) => now - new Date(n.publishedAt) < 1.5 * DAY && newsRelevant(n)).slice(0, 8);
      const custActions = customers().filter((c) => ["overdue", "today"].includes(nextStepState(c.crm)));
      const newCancels = all.filter((t) => t.bucket === "cancel" && t.firstSeen && new Date(t.firstSeen) >= since);
      const firstRun = tenders.length && tenders.every((t) => t.firstSeen && now - new Date(t.firstSeen) < 26 * 3600000);

      const row = (t) => `<div class="list-item" data-open="${esc(t.id)}" style="cursor:pointer">${datePill(t)}<div style="min-width:0">
        <h4>${esc(t.title)}</h4><div class="meta">${esc(t.authority)} · ${esc(t.dateKind || "İhale")}: ${esc(whenText(t))} · <b style="color:var(--${t.bucket})">${esc(countdown(t.tenderDate))}</b></div></div></div>`;
      const sec = (title, body, n, color) => `<div class="card card-pad" ${color ? `style="border-left:4px solid ${color}"` : ""}><h3>${title} <span class="muted small">${n ?? ""}</span></h3>${body}</div>`;
      const greet = ((h) => h < 12 ? "Günaydın" : h < 18 ? "İyi günler" : "İyi akşamlar")(new Date().getHours());

      return `
        <div class="page-head">
          <div><h1>${greet} — Sabah Özeti</h1>
            <p>${esc(new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}
            · Veri: ${DATA.generatedAt ? esc(relDate(DATA.generatedAt)) + " " + esc(new Date(DATA.generatedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })) : "—"}</p></div>
          <div style="display:flex;gap:8px"><button class="btn" data-action="copy-morning" type="button">⧉ Metin olarak kopyala</button><button class="btn" data-action="print" type="button">🖨 Yazdır</button></div>
        </div>
        <div class="card card-pad morning-lead">
          <b>${in2.length}</b> ihalenin son günü bugün/yarın · <b>${fresh.length}</b> yeni ihale radara düştü · bu hafta <b>${week.length}</b> ihale ·
          <b>${newDeals.length}</b> yeni sözleşme/sonuç · <b>${custActions.length}</b> müşteri aksiyonu
          ${firstRun ? `<div class="muted small">İlk tarama bugün yapıldığı için tüm ihaleler "yeni" sayılıyor; yarından itibaren yalnızca son 24 saatte gelenler listelenir.</div>` : ""}
        </div>
        <div class="grid two-col" style="margin-top:16px">
          <div class="grid" style="align-content:start">
            ${sec("🔴 Son gün bugün / yarın", in2.map(row).join("") || `<p class="muted small">Yok.</p>`, in2.length, "var(--urgent)")}
            ${sec("🆕 Son 24 saatte gelen ihaleler", fresh.map(row).join("") || `<p class="muted small">Yeni ilan yok.</p>`, fresh.length, "var(--accent)")}
            ${sec("🟠 Bu hafta (3–7 gün)", week.map(row).join("") || `<p class="muted small">Yok.</p>`, week.length, "var(--week)")}
            ${newCancels.length ? sec("⚠ Yeni iptal / zeyilname", newCancels.map(row).join(""), newCancels.length) : ""}
          </div>
          <div class="grid" style="align-content:start">
            ${sec("★ Takip listem", watched.map((t) => `<div class="list-item" data-open="${esc(t.id)}" style="cursor:pointer"><div><h4>${esc(t.title)}</h4>
              <div class="meta">${esc(STATUSES.find((s) => s.id === state.watch[t.id].status)?.label || "")} · <b style="color:var(--${t.bucket})">${esc(countdown(t.tenderDate))}</b></div></div></div>`).join("")
              || `<p class="muted small">Takip edilen aktif ihale yok.</p>`, watched.length)}
            ${sec("👥 Müşteri aksiyonları", custActions.map((c) => `<div class="list-item"><div><h4><a href="#/musteri/${encodeURIComponent(c.key)}">${esc(c.displayName)}</a></h4>
              <div class="meta">${esc(c.crm.nextStep || "")} · ${esc(fmtDate(c.crm.nextDate, false))}</div></div></div>`).join("") || `<p class="muted small">Bugün için planlı aksiyon yok.</p>`, custActions.length)}
            ${sec("🤝 Yeni sözleşmeler / sonuçlar (3 gün)", newDeals.map((x) => `<div class="list-item"><div><h4 style="font-weight:500"><b>${esc(x.winner)}</b> — ${esc(x.subject)}</h4>
              <div class="meta">${[x.amount ? esc(fmtMoney(x.amount)) : "", esc(x.client || ""), `<a href="${esc(x.url)}" target="_blank" rel="noopener">kaynak ↗</a>`].filter(Boolean).join(" · ")}</div></div></div>`).join("") || `<p class="muted small">Yok.</p>`, newDeals.length)}
            ${sec("📰 Öne çıkan haberler", topNews.map((n) => `<div class="list-item"><div><h4 style="font-weight:500"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h4>
              <div class="meta">${esc(n.source)}</div></div></div>`).join("") || `<p class="muted small">Yok.</p>`, topNews.length)}
            ${(() => {
              const rivals = prefs().rivals || [];
              if (!rivals.length) return "";
              const hits = [];
              rivals.forEach((name) => {
                const words = customerKey(name).split(" ").filter((w) => w.length >= 3 && !/^(İNŞAAT|SANAYİ|TİCARET|ANONİM|ŞİRKETİ|LİMİTED|ORTAKLIĞI|MÜHENDİSLİK|VE|İŞ)$/.test(w)).slice(0, 2);
                if (!words.length) return;
                news.filter((n) => now - new Date(n.publishedAt) < 3 * DAY && words.every((w) => customerKey(`${n.title} ${n.summary || ""}`).includes(w)))
                  .forEach((n) => hits.push({ name, n }));
                deals.filter((x) => x.winner === name && now - new Date(x.date) < 3 * DAY).forEach((x) => hits.push({ name, n: { title: `Yeni sözleşme: ${x.subject} (${fmtMoney(x.amount)})`, url: x.url, source: x.source } }));
              });
              return sec("⚑ Takip ettiğim rakipler (3 gün)", hits.map(({ name, n }) => `<div class="list-item"><div><h4 style="font-weight:500"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h4>
                <div class="meta"><a href="#/rakip/${encodeURIComponent(name)}">${esc(name)}</a> · ${esc(n.source)}</div></div></div>`).join("") || `<p class="muted small">Takip ettiğin ${rivals.length} rakip için yeni haber yok.</p>`, hits.length);
            })()}
          </div>
        </div>`;
    },

    kaynaklar() {
      const groups = [...new Set(sources.map((s) => s.group))];
      const methodLabel = { api: "API / JSON", html: "HTML tarama", rss: "RSS", browser: "Headless tarayıcı" };
      const statusLabel = { ok: "Çalışıyor", err: "Hata", planned: "Planlandı" };
      return `
        <div class="page-head"><div><h1>Kaynaklar</h1><p>Taranan siteler, tarama yöntemi, son tarama zamanı ve durumu.</p></div></div>
        <div class="card card-pad" style="margin-bottom:16px">
          <h3>Veriyi güncelleme</h3>
          <p class="small" style="margin:0">${CLOUD
            ? `Tarama bulutta (GitHub Actions) otomatik çalışır: her sabah 08:00 ve gün içinde 3 saatte bir. Anahtar kelime değişince veya aşağıdaki butonla ~10–15 dk içinde ek tarama yapılır; bitince panel kendini yeniler.
               <br>${scanButton()}`
            : `Proje klasöründeki <b>Guncelle.cmd</b> dosyasına çift tıkla (ya da zamanlanmış görev otomatik çalıştırır), bitince bu sayfayı yenile (F5).`}
          ${DATA.generatedAt ? `<br>Son güncelleme: <b>${esc(fmtDate(DATA.generatedAt))}</b> (${esc(relDate(DATA.generatedAt))}).` : ""}
          ${DATA.generatedAt && Date.now() - new Date(DATA.generatedAt) > 26 * 3600000 ? `<br><b style="color:var(--urgent)">Veri 1 günden eski — güncellemeyi çalıştır.</b>` : ""}</p>
        </div>
        ${CLOUD ? `<div class="card card-pad" style="margin-bottom:16px">
          <h3>Yerel geçmişi buluta aktar</h3>
          <p class="small" style="margin:0 0 8px">Bilgisayardaki yerel sürümün geçmişini (ihaleler, haberler, sözleşmeler) buluttakiyle birleştirir; aynı kayıt iki kez eklenmez.
            <b>Tender Radar\\scraper\\store</b> klasöründeki <code>tenders.json</code>, <code>news.json</code> ve <code>deals.json</code> dosyalarını birlikte seç.</p>
          <button class="btn" data-action="history-import" type="button">⬆ Geçmiş dosyalarını seç</button><input type="file" id="historyFile" accept=".json" multiple hidden>
        </div>` : ""}
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(360px,1fr))">
          ${groups.map((g) => `
            <div class="card card-pad"><h3>${esc(g)}</h3>
              ${sources.filter((s) => s.group === g).map((s) => `
                <div class="src-row">
                  <div style="min-width:0">
                    <div><span class="status-dot ${esc(s.status)}"></span><b>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</b></div>
                    ${s.note ? `<div class="muted small" style="margin-top:3px">${esc(s.note)}</div>` : ""}
                    ${s.lastRun ? `<div class="muted small">Son tarama: ${esc(fmtDate(s.lastRun))} · ${s.count ?? 0} kayıt</div>` : ""}
                    ${s.status === "err" && s.message ? `<div class="small" style="color:var(--urgent)">Hata: ${esc(s.message)}</div>` : ""}
                  </div>
                  <div style="text-align:right"><span class="tag">${esc(methodLabel[s.method] || s.method)}</span><div class="muted small" style="margin-top:4px">${esc(statusLabel[s.status] || s.status)}</div></div>
                </div>`).join("")}
            </div>`).join("")}
        </div>`;
    },

    ayarlar() {
      const scanned = { pos: new Set((SERVER_KW?.pos || []).map(trLower)), neg: new Set((SERVER_KW?.neg || []).map(trLower)) };
      const pending = kwPending();
      const synced = kwIsSynced();
      const kwBlock = (kind, title, desc) => `
        <div class="card card-pad">
          <h3>${title} <span class="muted small">${state.keywords[kind].length}</span></h3>
          <p class="muted small" style="margin:0">${desc}</p>
          <div class="kw-list">${state.keywords[kind].map((k, i) => {
            const isNew = SERVER_KW && !scanned[kind].has(trLower(k));
            return `<span class="kw ${kind === "neg" ? "neg" : ""} ${isNew ? "pending" : ""}" title="${isNew ? "Henüz taranmadı — sıradaki taramada uygulanacak" : "Son taramada kullanıldı"}">${isNew ? "⏳ " : ""}${esc(k)}<button data-kw-del="${kind}:${i}" aria-label="Sil" type="button">×</button></span>`;
          }).join("")}</div>
          <form class="kw-add" data-kw-add="${kind}"><input class="input" name="kw" placeholder="Yeni kelime ekle…" style="flex:1"><button class="btn primary" type="submit">Ekle</button></form>
        </div>`;
      const conn = CLOUD
        ? (synced
          ? `<b style="color:var(--later)">✓ Bulut taramasına bağlı.</b> Listeyi değiştirdiğinde kaydedilir; yeni kelimelerle tarama ~10–15 dk içinde otomatik yapılır. ${scanButton()}`
          : `<b style="color:var(--week)">Son değişiklik kaydedilemedi.</b> <button class="btn small primary" data-action="kw-sync" type="button">Tekrar dene</button>`)
        : fsState.handle
        ? (synced
          ? `<b style="color:var(--later)">✓ Taramaya bağlı.</b> Listeyi değiştirdiğinde <code>scraper/keywords.json</code> güncellenir; yeni kelimelerle tarama en geç ~30 dakika içinde otomatik yapılır (hemen görmek için <b>Guncelle.cmd</b>).`
          : `<b style="color:var(--week)">Son değişiklik dosyaya yazılmadı.</b> <button class="btn small primary" data-action="kw-sync" type="button">Şimdi kaydet</button>`)
        : fsState.supported
          ? `<b style="color:var(--week)">Taramaya henüz bağlı değil.</b> Buradaki değişikliklerin ilan.gov.tr aramasına yansıması için proje klasörünü bir kez seç:
             <button class="btn small primary" data-action="kw-connect" type="button">📁 Tender Radar klasörünü bağla</button>`
          : `Bu tarayıcı klasöre yazmayı desteklemiyor (Edge veya Chrome kullan). Alternatif: <button class="btn small" data-action="kw-download" type="button">keywords.json indir</button> ve <code>scraper</code> klasörüne koy.`;
      return `
        <div class="page-head"><div><h1>Anahtar Kelimeler</h1><p>Bu liste <b>hem ilan.gov.tr'de ne aranacağını hem de hangi ihalelerin listeye alınacağını</b> belirler.</p></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" data-action="export-settings" type="button" title="Anahtar kelimeler, takip listesi ve müşteri kartları">⬇ Yedek al</button>
            <button class="btn" data-action="import-settings" type="button">⬆ Yedeği yükle</button><input type="file" id="importFile" accept=".json" hidden>
            ${SERVER_KW ? `<button class="btn ghost" data-action="reset-kw" type="button" title="Yerel değişiklikleri at, son taramadaki listeye dön">Son taranan listeye dön</button>` : ""}</div></div>
        <div class="card card-pad" style="margin-bottom:16px">
          <h3>Taramaya bağlantı</h3>
          <p class="small" style="margin:0 0 6px">${conn}</p>
          ${pending ? `<p class="small" style="margin:0">⏳ <b>${pending}</b> değişiklik henüz taranmadı. Taranınca ilgili ihaleler panele otomatik düşer (panel kendini yeniler).</p>` : ""}
          ${SERVER_KW?.scannedAt ? `<p class="muted small" style="margin:6px 0 0">Son tarama: ${esc(fmtDate(SERVER_KW.scannedAt))} · ${SERVER_KW.pos.length} kelime arandı.</p>` : ""}
        </div>
        ${CLOUD ? (() => {
          const n = { daily: true, reminders: true, scope: "watch", email: "", ...(prefs().notify || {}) };
          return `<div class="card card-pad" style="margin-bottom:16px" id="notifyCard">
            <h3>E-posta bildirimleri</h3>
            <div class="notify-grid">
              <label class="check"><input type="checkbox" data-notify="daily" ${n.daily ? "checked" : ""}> Her sabah <b>günlük rapor</b> (08:00 sonrası ilk tarama)</label>
              <label class="check"><input type="checkbox" data-notify="reminders" ${n.reminders ? "checked" : ""}> İhaleye <b>3 gün kala hatırlatma</b></label>
              <label>Hatırlatma kapsamı
                <select data-notify="scope"><option value="watch" ${n.scope !== "all" ? "selected" : ""}>Yalnızca takip listemdeki ihaleler</option><option value="all" ${n.scope === "all" ? "selected" : ""}>Tüm ilgili ihaleler</option></select></label>
              <label>Alıcı e-posta <input class="input" type="email" data-notify="email" value="${esc(n.email)}" placeholder="Boşsa GitHub'daki MAIL_TO adresi"></label>
            </div>
            <p class="muted small" id="mailStatus" style="margin:8px 0 0">Son gönderim bilgisi yükleniyor…</p>
          </div>`;
        })() : ""}
        <div class="card card-pad" style="margin-bottom:16px">
          <h3>Nasıl çalışır?</h3>
          <ul class="small" style="margin:0;padding-left:18px;line-height:1.7">
            <li><b>İlgi alanı kelimeleri</b> ilan.gov.tr'de tek tek aranır; bir ihale, bu kelimelerden biri <b>ihalenin adında veya iş tanımında</b> geçiyorsa listeye alınır (yalnızca ilan metninin derinlerinde geçenler alınmaz — gürültüyü önler).</li>
            <li>Yeni eklediğin kelime, <b>şu an yayında olan</b> ilanlarda da aranır — yani yalnızca bundan sonra çıkacak ihaleler değil, hâlâ açık olan eski ilanlar da gelir.</li>
            <li>4 harf ve altı kısaltmalar (RTU, PLC, OMS…) tam kelime olarak eşleşir; uzun kelimeler Türkçe eklerle de eşleşir ("otomasyon" → "otomasyonu").</li>
            <li><b>Hariç tutulacak kelimeler</b> ihalenin adında/konusunda veya idare adında geçerse ihale elenir.</li>
          </ul>
        </div>
        <div class="grid two-col">
          ${kwBlock("pos", "İlgi alanı kelimeleri (aranır)", "ilan.gov.tr'de aranır ve ihale adı/konusunda geçmesi şartıyla listeye alınır.")}
          ${kwBlock("neg", "Hariç tutulacak kelimeler", "Bu kelimeler geçen ihaleler elenir.")}
        </div>
        <p class="muted small" style="margin-top:16px">${CLOUD
          ? "Takip listesi, notlar, müşteri kartları ve bildirim ayarları hesabına kayıtlıdır; tüm cihazlarda aynıdır. \"Yedek al\" ile ayrıca dosya olarak saklayabilirsin."
          : "Takip listesi, notlar ve müşteri kartları bu tarayıcıda saklanır. Tarayıcı verisini temizlemeden önce veya başka bilgisayara geçerken \"Yedek al\" kullan."}</p>`;
    }
  };

  function aggregateWinners() {
    const m = new Map();
    deals.forEach((x) => {
      const r = m.get(x.winner) || { name: x.winner, count: 0, totals: {}, sectors: new Set(), clients: new Set(), last: x.date, deals: [] };
      r.count++;
      r.deals.push(x);
      if (x.amount) r.totals[x.amount.currency] = (r.totals[x.amount.currency] || 0) + x.amount.amount;
      r.sectors.add(x.sector);
      if (x.client) r.clients.add(x.client);
      if (new Date(x.date) > new Date(r.last)) r.last = x.date;
      m.set(x.winner, r);
    });
    return [...m.values()].map((r) => {
      const disc = r.deals.map(discountOf).filter((v) => v != null);
      const bids = r.deals.map((x) => x.bidders).filter((v) => v != null);
      r.avgDiscount = disc.length ? disc.reduce((a, b) => a + b, 0) / disc.length : null;
      r.avgBidders = bids.length ? bids.reduce((a, b) => a + b, 0) / bids.length : null;
      r.tryTotal = r.totals.TRY || 0;
      return r;
    }).sort((a, b) => b.tryTotal - a.tryTotal || b.count - a.count || new Date(b.last) - new Date(a.last));
  }

  // ---------- Grafik ve analitik yardımcıları (tek seri; renkler styles.css'teki --series-1 / --seq-*) ----------
  const prefs = () => store.get("prefs", {}) || {};
  const savePrefs = (p) => store.set("prefs", p);
  const deaccent = (s) => trLower(s).replace(/[çğıöşüâîû]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" }[c])).replace(/[^a-z0-9]/g, "");
  const monthKey = (iso) => { if (!iso) return null; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const monthLabel = (k) => new Date(k + "-15T12:00:00").toLocaleDateString("tr-TR", { month: "short", year: "2-digit" });
  const lastMonths = (n) => { const out = []; const d = new Date(); d.setDate(15); for (let i = n - 1; i >= 0; i--) { const x = new Date(d); x.setMonth(d.getMonth() - i); out.push(monthKey(x.toISOString())); } return out; };
  const fmtNum = (n, dig = 0) => (n == null ? "—" : n.toLocaleString("tr-TR", { maximumFractionDigits: dig }));
  const countBy = (arr, fn) => { const m = new Map(); arr.forEach((x) => { const k = fn(x); if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const sumBy = (arr, fn, valFn) => { const m = new Map(); arr.forEach((x) => { const k = fn(x); const v = valFn(x); if (k && v) m.set(k, (m.get(k) || 0) + v); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const tryAmount = (x) => (x.amount && x.amount.currency === "TRY" ? x.amount.amount : 0);
  const TENDER_TYPES = ["Yapım İşi", "Mal Alımı", "Kiralama ve Hizmet Alımı", "Danışmanlık Hizmet Alımı"];
  const typeOf = (t) => (t.categories || []).find((c) => TENDER_TYPES.includes(c) || /Alımı|İşi|Hizmet/.test(c)) || (t.procedure || "").split(" · ")[1] || "Diğer";
  const topicOf = (t) => (t.categories || []).filter((c) => !TENDER_TYPES.includes(c) && !/Alımı|İşi$/.test(c));

  // Yatay çubuk listesi: rows = [[etiket, değer, ipucu?]], değer biçimleyici fmt
  function barList(rows, fmt = (v) => fmtNum(v), opts = {}) {
    if (!rows.length) return `<p class="muted small">Veri yok.</p>`;
    const max = Math.max(...rows.map((r) => r[1]), 1);
    return `<div class="bars">${rows.map(([label, v, tip, href]) => `
      <div class="row" data-tip="${esc(tip || `${label}: ${fmt(v)}`)}">
        <span class="name" title="${esc(label)}">${href ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label)}</span>
        <div class="track"><div class="fill" style="width:${Math.max(1.5, (v / max) * 100)}%"></div></div>
        <span class="val">${fmt(v)}</span>
      </div>`).join("")}</div>${opts.note ? `<div class="muted small" style="margin-top:6px">${opts.note}</div>` : ""}`;
  }
  // Dikey sütun grafiği (aylık): data = [{ key, label, value, tip }]
  function columnChart(data, fmt = (v) => fmtNum(v)) {
    if (!data.length || !data.some((d) => d.value)) return `<p class="muted small">Bu dönemde veri yok.</p>`;
    const W = 320, H = 130, padB = 18, padT = 16, gap = 2;   // küçük görünüm kutusu → yazılar okunur boyutta ölçeklenir
    const max = Math.max(...data.map((d) => d.value), 1);
    const bw = (W - gap * (data.length - 1)) / data.length;
    const maxIdx = data.findIndex((d) => d.value === max);
    const bars = data.map((d, i) => {
      const h = d.value ? Math.max(3, ((H - padB - padT) * d.value) / max) : 0;
      const x = i * (bw + gap), y = H - padB - h, r = Math.min(4, bw / 2, h);
      const path = h ? `M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - padB} Z` : "";
      const showLbl = data.length <= 6 || (data.length - 1 - i) % 3 === 0;   // son ay her zaman etiketli
      return `<g class="col" data-tip="${esc(d.tip || `${d.label}: ${fmt(d.value)}`)}">
        <rect x="${x}" y="${padT}" width="${bw}" height="${H - padB - padT}" fill="transparent"/>
        ${path ? `<path d="${path}" class="col-fill"/>` : ""}
        ${showLbl ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="axis-lbl">${esc(d.label)}</text>` : ""}
        ${i === maxIdx ? `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" class="val-lbl">${esc(fmt(d.value))}</text>` : ""}
      </g>`;
    }).join("");
    return `<svg class="colchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Aylık dağılım"><line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" class="baseline"/>${bars}</svg>`;
  }
  function statTiles(items) {
    return `<div class="stat-tiles">${items.map(([label, value, sub]) => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`).join("")}</div>`;
  }
  // ---------- İhale haritası ----------
  const GEO_URL = "https://cdn.jsdelivr.net/gh/alpers/Turkey-Maps-GeoJSON@master/tr-cities.json";
  let GEO = null;
  const mapFmt = (metric, v) => (metric === "deals" ? fmtMoney({ amount: v, currency: "TRY" }) : fmtNum(v));
  function provinceStats() {
    const f = state.mapFilter;
    const cs = customers().filter((c) => !f.seg || c.segment === f.seg);
    const m = new Map();
    const get = (city) => { const k = deaccent(city); if (!m.has(k)) m.set(k, { name: city, active: 0, all: 0, inst: 0, deals: 0, custs: [], tenders: [] }); return m.get(k); };
    cs.forEach((c) => {
      // İhaleler, ihalenin yapıldığı ile; kurum ve sözleşmeler kurumun iline sayılır
      c.tenders.forEach((t) => { if (!t.city) return; const p = get(t.city); p.all++; if (t.bucket !== "past" && t.bucket !== "cancel" && !isDismissed(t)) { p.active++; p.tenders.push(t); } });
      if (c.city) { const p = get(c.city); p.inst++; p.custs.push(c); p.deals += c.deals.reduce((a, x) => a + tryAmount(x), 0); }
    });
    return m;
  }
  function eachCoord(geom, fn) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    polys.forEach((poly) => poly.forEach((ring) => ring.forEach(fn)));
  }
  async function drawMap() {
    const el = $("#trMap");
    if (!el) return;
    try { if (!GEO) GEO = await (await fetch(GEO_URL)).json(); }
    catch { el.innerHTML = `<p class="muted small">Harita verisi yüklenemedi (internet bağlantısını kontrol et).</p>`; return; }
    if (!$("#trMap")) return;   // bu arada başka sayfaya geçildiyse
    const metric = state.mapFilter.metric;
    const stats = provinceStats();
    const k0 = Math.cos((39 * Math.PI) / 180);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    GEO.features.forEach((ft) => eachCoord(ft.geometry, ([lon, lat]) => { const x = lon * k0, y = -lat; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }));
    const W = 1000, s = W / (maxX - minX), H = Math.round((maxY - minY) * s);
    const pt = ([lon, lat]) => `${((lon * k0 - minX) * s).toFixed(1)},${((-lat - minY) * s).toFixed(1)}`;
    const vals = GEO.features.map((ft) => { const p = stats.get(deaccent(ft.properties.name)); return p ? p[metric] : 0; });
    const max = Math.max(...vals, 0);
    const step = (v) => (!v || !max ? 0 : Math.min(5, Math.max(1, Math.ceil((v / max) * 5))));
    const sel = state.mapFilter.sel;
    const paths = GEO.features.map((ft, i) => {
      const polys = ft.geometry.type === "Polygon" ? [ft.geometry.coordinates] : ft.geometry.coordinates;
      const d = polys.map((poly) => poly.map((ring) => "M" + ring.map(pt).join("L") + "Z").join("")).join("");
      const name = ft.properties.name;
      return `<path d="${d}" class="prov seq-${step(vals[i])} ${sel && deaccent(sel) === deaccent(name) ? "sel" : ""}" data-prov="${esc(name)}" data-tip="${esc(`${name}: ${mapFmt(metric, vals[i])}`)}"/>`;
    }).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="tr-map-svg" role="img" aria-label="Türkiye il haritası">${paths}</svg>`;
    const labels = [1, 2, 3, 4, 5].map((n) => mapFmt(metric, (max * n) / 5));
    $("#mapLegend").innerHTML = max
      ? `<span class="muted small">0</span>${[1, 2, 3, 4, 5].map((n) => `<span class="sw seq-${n}" title="≤ ${esc(labels[n - 1])}"></span>`).join("")}<span class="muted small">${esc(mapFmt(metric, max))}</span><span class="muted small" style="margin-left:12px"><span class="sw seq-0"></span> veri yok</span>`
      : `<span class="muted small">Bu ölçüt için henüz veri yok.</span>`;
    const rows = [...stats.values()].filter((p) => p[metric]).sort((a, b) => b[metric] - a[metric]);
    $("#mapTable").innerHTML = `<table><thead><tr><th>İl</th><th>Aktif ihale</th><th>Tüm ihaleler</th><th>Kurum</th><th>Bilinen sözleşme</th></tr></thead><tbody>${rows.map((p) => `
      <tr><td><a href="javascript:void 0" data-prov="${esc(p.name)}">${esc(p.name)}</a></td><td class="num">${p.active}</td><td class="num">${p.all}</td><td class="num">${p.inst}</td><td class="num">${p.deals ? esc(fmtMoney({ amount: p.deals, currency: "TRY" })) : "—"}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Veri yok.</td></tr>`}</tbody></table>`;
    renderMapSide(stats);
  }
  function renderMapSide(stats) {
    const side = $("#mapSide"); const sel = state.mapFilter.sel;
    if (!side || !sel) return;
    const p = (stats || provinceStats()).get(deaccent(sel));
    if (!p) { side.innerHTML = `<h3>${esc(sel)}</h3><p class="muted small">Bu ilde kayıtlı ihale veya kurum yok.</p>`; return; }
    const custs = p.custs.slice().sort((a, b) => b.tenders.length - a.tenders.length);
    side.innerHTML = `<h3>${esc(p.name)}</h3>
      ${statTiles([["Aktif ihale", fmtNum(p.active)], ["Tüm ihaleler", fmtNum(p.all)], ["Kurum", fmtNum(p.inst)], ["Bilinen sözleşme", p.deals ? esc(fmtMoney({ amount: p.deals, currency: "TRY" })) : "—"]])}
      <h4 class="chart-title" style="margin-top:14px">Kurumlar (ihale sayısına göre)</h4>
      ${barList(custs.slice(0, 8).map((c) => [c.displayName, c.tenders.length, `${c.displayName}: ${c.tenders.length} ihale, ${c.active.length} aktif`, `#/musteri/${encodeURIComponent(c.key)}`]), (v) => `${v} ihale`)}
      <h4 class="chart-title" style="margin-top:14px">Aktif ihaleler</h4>
      ${p.tenders.sort((a, b) => new Date(a.tenderDate) - new Date(b.tenderDate)).map((t) => `<div class="list-item" data-open="${esc(t.id)}" style="cursor:pointer"><div style="min-width:0"><h4 style="font-weight:500">${esc(t.title)}</h4>
        <div class="meta">${esc(t.authority)} · <b style="color:var(--${t.bucket})">${esc(countdown(t.tenderDate))}</b></div></div></div>`).join("") || `<p class="muted small">Aktif ihale yok.</p>`}`;
  }

  // E-posta günlüğü: Anahtar Kelimeler sayfasında son gönderim bilgisi
  function loadMailLog() {
    if (!CLOUD) return;
    CLOUD.getDataset("mail_log").then((l) => {
      const el = $("#mailStatus"); if (!el) return;
      const uid = CLOUD.user.id;
      const last = l && l.daily && (l.daily[uid] || l.daily.varsayilan);
      const rem = l && l.reminded && l.reminded[uid] ? Object.keys(l.reminded[uid]).length : 0;
      el.innerHTML = l ? `Son günlük rapor: <b>${last ? esc(fmtDate(last + "T08:00:00", false)) : "henüz gönderilmedi"}</b> · son 40 günde ${rem} ihale için hatırlatma gönderildi.
        E-postalar GitHub'daki SMTP ayarlarıyla gönderilir (SETUP.md → E-posta).`
        : `Henüz e-posta gönderilmedi. GitHub'da SMTP ayarları tanımlanınca (SETUP.md → E-posta) ilk tarama sonrası gönderim başlar.`;
    }).catch(() => { const el = $("#mailStatus"); if (el) el.textContent = "E-posta günlüğü okunamadı."; });
  }

  // ---------- Grafik ipucu (tooltip): data-tip taşıyan her öğe ----------
  const vizTip = document.createElement("div");
  vizTip.className = "viz-tip"; vizTip.hidden = true;
  document.body.appendChild(vizTip);
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { vizTip.hidden = true; return; }
    vizTip.textContent = t.getAttribute("data-tip"); vizTip.hidden = false;
  });
  document.addEventListener("mousemove", (e) => {
    if (vizTip.hidden) return;
    vizTip.style.left = Math.min(window.innerWidth - vizTip.offsetWidth - 8, e.clientX + 14) + "px";
    vizTip.style.top = Math.min(window.innerHeight - vizTip.offsetHeight - 8, e.clientY + 16) + "px";
  });

  const dataNote = `Tutarlar yalnızca kamuya açıklanmış sözleşmelerden (Yatırımlar Dergisi haberleri) hesaplanır; ihale sayıları ilan.gov.tr'de yayımlanan ve anahtar kelimelerinize uyan ihalelerdendir. Veri her taramada birikir.`;

  // ---------- Detay çekmecesi ----------
  function openDrawer(id) {
    const t0 = tenders.find((x) => x.id === id);
    if (!t0) return;
    const t = { ...t0, bucket: t0.isCancelled ? "past" : bucketOf(t0.tenderDate), rel: relevance(t0) };
    const w = state.watch[id];
    const drawer = $("#drawer");
    const cust = customerKey(t.authority);
    drawer.innerHTML = `
      <div class="d-head">
        <button class="btn ghost small close" data-action="close-drawer" type="button">✕</button>
        <span class="badge src-${esc(t.sourceType)}">${esc(SOURCE_TYPES[t.sourceType])}</span>
        ${t.isCancelled ? `<span class="badge warn">İPTAL</span>` : t.isAddendum ? `<span class="badge warn">Zeyilname</span>` : ""}
        ${(t.categories || []).map((c) => `<span class="tag">${esc(c)}</span>`).join(" ")}
        <h2>${esc(t.title)}</h2>
        <a class="muted" href="#/musteri/${encodeURIComponent(cust)}">${esc(t.authority)} → müşteri kartı</a>
      </div>
      <div class="d-body">
        <div style="--c:var(--${t.bucket})"><div class="big-count">${esc(t.isCancelled ? "İhale iptal edildi" : countdown(t.tenderDate))}</div>
          <div class="muted small">${esc(t.dateKind || "İhale tarihi")}: ${esc(whenText(t))}</div></div>
        <div class="actions">
          ${t.ekapUrl ? `<a class="btn primary" href="${esc(t.ekapUrl)}" target="_blank" rel="noopener" title="EKAP güvenlik kontrolünü (Cloudflare) onayladıktan sonra ihale açılır">↗ EKAP'ta aç (İKN ${esc(t.ikn)})</a>` : ""}
          ${t.ilanUrl ? `<a class="btn ${t.ekapUrl ? "" : "primary"}" href="${esc(t.ilanUrl)}" target="_blank" rel="noopener">↗ İlanın tam metni (ilan.gov.tr)</a>` : ""}
        </div>
        <div class="summary-box" style="margin-top:16px"><b>Özet (ilan metninden)</b>${esc(t.summary)}</div>
        <dl class="kv">
          <dt>İKN / Referans</dt><dd>${esc(t.ikn || t.refNo || "—")}</dd>
          <dt>ilan.gov.tr no</dt><dd>${esc(t.adNo || "—")}</dd>
          <dt>Usul / tür</dt><dd>${esc(t.procedure || "—")}</dd>
          <dt>İl / ilçe</dt><dd>${esc([t.city, t.county].filter(Boolean).join(" / "))}</dd>
          <dt>Yaklaşık maliyet</dt><dd>${t.estimatedValue ? esc(fmtMoney(t.estimatedValue)) : `<span class="muted">İlanda yayımlanmamış</span>`}</dd>
          <dt>Radara ilk düştüğü</dt><dd>${t.firstSeen ? esc(fmtDate(t.firstSeen)) : "—"}</dd>
          <dt>Eşleşen kelimeler</dt><dd>${(t.matched || t.rel.hits).map((h) => `<span class="tag">${esc(h)}</span>`).join(" ") || "—"}</dd>
        </dl>
        ${t.ekapUrl ? `<p class="muted small">EKAP bağlantısı, İKN ile arama sayfasını açar; Cloudflare "gerçek kişi" kutusunu işaretleyince ihale listelenir (EKAP'ın zorunlu güvenlik adımı).</p>` : ""}
        <div class="actions">
          <button class="btn ${w ? "on" : "primary"}" data-star="${esc(t.id)}" type="button">${w ? "★ Takipte" : "☆ Takibe al"}</button>
          ${isDismissed(t) ? `<button class="btn" data-restore="${esc(t.id)}" type="button">↩ Listeye geri al</button>`
            : `<button class="btn ghost" data-dismiss="${esc(t.id)}" type="button">✕ Listeden çıkar</button>`}
          <button class="btn" data-action="ics" data-id="${esc(t.id)}" type="button">📅 Takvime ekle</button>
          <button class="btn" data-action="copy" data-id="${esc(t.id)}" type="button">⧉ Özeti kopyala</button>
        </div>
        ${w ? `
          <h3 style="margin:24px 0 8px;font-size:14px">Teklif süreci</h3>
          <select data-status="${esc(t.id)}" style="width:100%">${STATUSES.map((s) => `<option value="${s.id}" ${w.status === s.id ? "selected" : ""}>${s.label}</option>`).join("")}</select>
          <h3 style="margin:16px 0 8px;font-size:14px">Notlarım</h3>
          <textarea class="input" data-note="${esc(t.id)}" placeholder="Rakipler, iş ortakları, teknik notlar, fiyat stratejisi…">${esc(w.note || "")}</textarea>` : ""}
      </div>`;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    $("#drawerBackdrop").hidden = false;
    drawer.dataset.id = id;
  }
  function closeDrawer() {
    const drawer = $("#drawer");
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    $("#drawerBackdrop").hidden = true;
    delete drawer.dataset.id;
  }

  // ---------- Dışa aktarma ----------
  function icsFor(list) {
    const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const escI = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
    const events = list.map((t) => [
      "BEGIN:VEVENT",
      `UID:${t.id}@tender-radar`,
      `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(t.tenderDate)}`,
      `DTEND:${stamp(new Date(new Date(t.tenderDate).getTime() + 3600000).toISOString())}`,
      `SUMMARY:${escI("İhale: " + t.title)}`,
      `DESCRIPTION:${escI(`${t.authority}\n${t.dateKind || "İhale tarihi"}\nİKN/Ref: ${refOf(t)}\n${t.summary}\n${t.url || ""}`)}`,
      `LOCATION:${escI(t.city)}`,
      "BEGIN:VALARM", "TRIGGER:-P3D", "ACTION:DISPLAY", "DESCRIPTION:İhaleye 3 gün kaldı", "END:VALARM",
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:İhaleye 1 gün kaldı", "END:VALARM",
      "END:VEVENT"
    ].join("\r\n"));
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tender Radar//TR", ...events, "END:VCALENDAR"].join("\r\n");
  }

  function exportCsv() {
    const rows = filteredTenders();
    const head = ["Kalan süre", "Tarih türü", "Tarih", "Başlık", "İdare", "Kaynak", "İl", "İKN / Ref", "Kategoriler", "Özet", "EKAP linki", "İlan linki"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((t) => [BUCKETS[t.bucket].label, t.dateKind || "İhale tarihi", whenText(t), t.title, t.authority, SOURCE_TYPES[t.sourceType],
      t.city, refOf(t), (t.categories || []).join(", "), t.summary, t.ekapUrl || "", t.ilanUrl || t.url].map(q).join(";"));
    // BOM + ";" ayırıcı: Türkçe Excel doğrudan açar
    download(`ihaleler_${new Date().toISOString().slice(0, 10)}.csv`, "﻿" + [head.map(q).join(";"), ...lines].join("\r\n"), "text/csv;charset=utf-8");
  }

  // ---------- Anahtar kelimeleri taramaya aktarma (File System Access API) ----------
  // Tarayıcı normalde diske yazamaz; Edge/Chrome'da kullanıcı proje klasörünü bir kez seçince
  // panel scraper/keywords.json dosyasını doğrudan günceller. Klasör izni IndexedDB'de saklanır.
  const fsState = { supported: !CLOUD && typeof window.showDirectoryPicker === "function", handle: null };
  const idb = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open("tender-radar", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
  };
  const kwSig = (kw) => JSON.stringify({ p: kw.pos.map(trLower).sort(), n: kw.neg.map(trLower).sort() });
  let cloudKwOk = true;   // bulutta son kelime kaydı başarılı mı
  const kwIsSynced = () => (CLOUD ? cloudKwOk : store.get("kwSyncedSig", null) === kwSig(state.keywords));

  // ---------- "Şimdi tara" (bulut) ----------
  function scanButton() {
    if (!CLOUD) return "";
    const req = CLOUD.scanRequest?.requestedAt;
    const waiting = req && (!DATA.generatedAt || new Date(req) > new Date(DATA.generatedAt));
    return waiting
      ? `<span class="small">⏳ Tarama isteği ${esc(relTime(req))} gönderildi — sırada; bitince panel kendini yeniler.</span>`
      : `<button class="btn small primary" data-action="scan-now" type="button">⟳ Şimdi tara</button>`;
  }
  function relTime(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "az önce" : m < 60 ? `${m} dk önce` : `${Math.round(m / 60)} sa önce`;
  }
  async function requestScan() {
    try { await CLOUD.requestScan(); toast("Tarama isteği alındı — ~10–15 dk içinde çalışır, bitince panel kendini yeniler"); }
    catch (e) { toast("İstek gönderilemedi: " + e.message); }
    render();
  }
  function kwPending() {
    if (!SERVER_KW) return 0;
    const a = { pos: new Set(SERVER_KW.pos.map(trLower)), neg: new Set(SERVER_KW.neg.map(trLower)) };
    const b = { pos: new Set(state.keywords.pos.map(trLower)), neg: new Set(state.keywords.neg.map(trLower)) };
    let n = 0;
    for (const k of ["pos", "neg"]) { b[k].forEach((x) => { if (!a[k].has(x)) n++; }); a[k].forEach((x) => { if (!b[k].has(x)) n++; }); }
    return n;
  }
  const kwFileContent = () => JSON.stringify({ pos: state.keywords.pos, neg: state.keywords.neg, updatedAt: state.keywords.updatedAt || new Date().toISOString() }, null, 2);

  async function writeKeywordsFile() {
    const h = fsState.handle;
    if (!h) return false;
    const opt = { mode: "readwrite" };
    if ((await h.queryPermission(opt)) !== "granted" && (await h.requestPermission(opt)) !== "granted") return false;
    const fh = await h.getFileHandle("keywords.json", { create: true });
    const w = await fh.createWritable();
    await w.write(kwFileContent());
    await w.close();
    store.set("kwSyncedSig", kwSig(state.keywords));
    return true;
  }
  async function connectFolder() {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: "tender-radar", mode: "readwrite" }); } catch { return; } // kullanıcı vazgeçti
    let scraper = null;
    try { scraper = await dir.getDirectoryHandle("scraper"); await scraper.getFileHandle("config.json"); }
    catch { try { await dir.getFileHandle("config.json"); await dir.getFileHandle("Update-TenderRadar.ps1"); scraper = dir; } catch { scraper = null; } }
    if (!scraper) { toast("Bu klasör Tender Radar değil — içinde 'scraper' klasörü olan proje klasörünü seç"); return; }
    fsState.handle = scraper;
    try { await idb.set("scraperDir", scraper); } catch { /* izin yalnızca bu oturum için geçerli olur */ }
    await syncKeywords(true);
  }
  // Kelime listesi her değiştiğinde çağrılır (kullanıcı tıklamasıyla tetiklendiği için izin istenebilir)
  async function syncKeywords(announce) {
    state.keywords.updatedAt = state.keywords.updatedAt || new Date().toISOString();
    if (CLOUD) {
      try { await CLOUD.saveKeywords(state.keywords); cloudKwOk = true; toast("Kaydedildi — yeni kelimelerle tarama ~10–15 dk içinde yapılacak"); }
      catch (e) { cloudKwOk = false; toast("Kelimeler kaydedilemedi: " + e.message); }
      if (state.view === "ayarlar") render();
      return;
    }
    store.set("keywords", state.keywords);
    let ok = false;
    try { ok = await writeKeywordsFile(); } catch (e) { toast("keywords.json yazılamadı: " + e.message); }
    if (ok) toast(announce ? "Klasör bağlandı ✓ — kelime değişiklikleri artık taramaya aktarılacak" : "Kaydedildi — yeni kelimelerle tarama en geç ~30 dk içinde yapılacak");
    else if (!fsState.handle) toast("Bu tarayıcıda kaydedildi. Taramaya aktarmak için Anahtar Kelimeler sayfasından klasörü bağla.");
    if (state.view === "ayarlar") render();
  }
  function keywordsChanged() {
    state.keywords.updatedAt = new Date().toISOString();
    if (!CLOUD) store.set("keywords", state.keywords);
    render(); updateNavCounts();
    syncKeywords(false);
  }
  (async () => {
    if (!fsState.supported) return;
    try { fsState.handle = (await idb.get("scraperDir")) || null; } catch { fsState.handle = null; }
    // Bağlıysa ve panelde yazılmamış değişiklik varsa sessizce yazmayı dene (izin zaten verilmişse)
    if (fsState.handle && !kwIsSynced()) {
      try { if ((await fsState.handle.queryPermission({ mode: "readwrite" })) === "granted") await writeKeywordsFile(); } catch { /* sonra */ }
    }
    if (state.view === "ayarlar") render();
  })();

  // ---------- Otomatik yenileme: yeni veri gelince panel kendini günceller ----------
  const sess = {
    get(k) { try { return sessionStorage.getItem("tr." + k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem("tr." + k, v); } catch { /* yoksay */ } }
  };
  let newIds = new Set(store.get("newIds", []));
  function isBusy() {
    return $("#drawer").classList.contains("open") || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
  }
  function pollVersion() {
    if (CLOUD) {
      CLOUD.latestVersion().then((v) => { if (v) { window.TR_DATA_VERSION = v; checkVersion(); } }).catch(() => { /* ağ hatası: sonraki denemede */ });
      return;
    }
    const s = document.createElement("script");
    s.src = "data/version.js?t=" + Date.now();
    s.onload = () => { s.remove(); checkVersion(); };
    s.onerror = () => s.remove();
    document.head.appendChild(s);
  }
  function checkVersion(force) {
    const v = window.TR_DATA_VERSION;
    if (!v || !v.generatedAt) return;
    if (DATA.generatedAt && new Date(v.generatedAt) <= new Date(DATA.generatedAt)) return;
    if (sess.get("reloadedFor") === v.generatedAt) return;          // veri eksikse sonsuz döngüye girme
    const known = new Set(tenders.map((t) => t.id));
    // İlk tarama verisi geldiğinde her şeyi "yeni" sayma
    const fresh = DATA.generatedAt ? (v.tenderIds || []).filter((id) => !known.has(id)) : [];
    if (isBusy() && !force) { showUpdateBanner(fresh.length); return; }
    sess.set("reloadedFor", v.generatedAt);
    if (fresh.length) store.set("newIds", [...new Set([...newIds, ...fresh])]);
    sess.set("freshCount", String(fresh.length));
    Promise.resolve(CLOUD && CLOUD.flush()).finally(() => location.reload());   // bekleyen kayıtları gönder, sonra yenile
  }
  function showUpdateBanner(n) {
    const b = $("#updateBanner");
    b.innerHTML = `🔄 Yeni veri geldi${n ? ` — <b>${n} yeni ihale</b>` : ""}. <button class="btn small primary" data-action="reload-now" type="button">Şimdi yenile</button>`;
    b.hidden = false;
  }
  function showNewBanner() {
    const b = $("#updateBanner");
    const cnt = [...newIds].filter((id) => tenders.some((t) => t.id === id)).length;
    const justNow = Number(sess.get("freshCount") || 0);
    sess.set("freshCount", "0");
    if (!cnt) { b.hidden = true; document.title = "Tender Radar"; return; }
    b.innerHTML = `🆕 <b>${cnt} yeni ihale</b> geldi${justNow ? ` (az önce ${justNow})` : ""} — kartlarda <span class="badge new">YENİ</span> etiketiyle işaretli.
      <a class="btn small" href="#/ihaleler">Panoda gör</a> <button class="btn small ghost" data-action="clear-new" type="button">Gördüm ✕</button>`;
    b.hidden = false;
    document.title = `(${cnt}) Tender Radar`;
    if (justNow) toast(`${justNow} yeni ihale geldi`);
  }

  // ---------- Router & render ----------
  function render() {
    const v = views[state.view] ? state.view : "ozet";
    $("#view").innerHTML = views[v]();
    if (v === "harita") drawMap();
    if (v === "ayarlar") loadMailLog();
    const navV = v === "musteri" ? "musteriler" : v === "rakip" ? "rakipler" : v;
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === navV));
  }
  function updateNavCounts() {
    const active = tenders.filter((t) => daysLeft(t.tenderDate) >= 0 && !isDismissed(t) && relevance(t).score >= 0).length;
    $("#navCountTenders").textContent = active || "";
    $("#navCountWatch").textContent = Object.keys(state.watch).length || "";
  }
  function route() {
    const [view, ...rest] = (location.hash.replace(/^#\//, "") || "ozet").split("?")[0].split("/");
    state.view = view;
    state.param = rest.length ? decodeURIComponent(rest.join("/")) : null;
    $("#sidebar").classList.remove("open");
    render();
    window.scrollTo(0, 0);
  }

  function toggleWatch(id) {
    if (state.watch[id]) { delete state.watch[id]; toast("Takipten çıkarıldı"); }
    else { state.watch[id] = { status: "takip", note: "", addedAt: new Date().toISOString() }; toast("Takip listesine eklendi ★"); }
    saveWatch();
    render();
    if ($("#drawer").dataset.id === id) openDrawer(id);
  }

  // ---------- Olaylar ----------
  document.addEventListener("click", (e) => {
    // Kart içindeki dış bağlantılar kartı açmasın, doğrudan kaynağa gitsin
    if (e.target.closest("a[href]") && !e.target.closest("[data-star],[data-action]")) return;
    const el = e.target.closest("[data-star],[data-dismiss],[data-restore],[data-open],[data-src],[data-action],[data-tab],[data-newstype],[data-sort],[data-go],[data-kw-del],[data-crm],[data-seg],[data-prov]");
    if (!el) return;
    if (el.dataset.dismiss) {
      e.stopPropagation();
      const t = tenders.find((x) => x.id === el.dataset.dismiss);
      confirmBox({
        title: "Bu ihaleyi listeden çıkarmak istediğine emin misin?",
        html: `<p style="margin:0 0 6px"><b>${esc(t ? t.title : "")}</b></p><p class="muted small" style="margin:0">${esc(t ? t.authority : "")}</p>
          <p class="small" style="margin:10px 0 0">İhale tüm listelerden kalkar ve takip listenden çıkar. Sayfanın altındaki <b>"Listeden çıkardığım ihaleler"</b> bölümünden istediğin zaman geri alabilirsin.</p>`,
        ok: "Evet, listeden çıkar"
      }).then((yes) => { if (yes) dismissTender(el.dataset.dismiss); });
      return;
    }
    if (el.dataset.restore) { e.stopPropagation(); restoreTender(el.dataset.restore); if ($("#drawer").dataset.id === el.dataset.restore) openDrawer(el.dataset.restore); return; }
    if (el.dataset.prov) {
      state.mapFilter.sel = el.dataset.prov; store.set("mapFilter", state.mapFilter);
      drawMap(); $("#mapSide")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); return;
    }
    const d = el.dataset;

    if (d.star) { e.stopPropagation(); toggleWatch(d.star); return; }
    if (d.open) { openDrawer(d.open); return; }
    if (d.go) { location.hash = "#/" + d.go; return; }
    if (d.src) {
      const i = state.f.src.indexOf(d.src);
      i >= 0 ? state.f.src.splice(i, 1) : state.f.src.push(d.src);
      saveFilters(); render(); return;
    }
    if (d.tab) { state.piyasaTab = d.tab; render(); return; }
    if (d.newstype !== undefined) { state.newsType = d.newstype; render(); return; }
    if (d.sort) {
      state.dealSort = { key: d.sort, dir: state.dealSort.key === d.sort ? -state.dealSort.dir : -1 };
      render(); return;
    }
    if (d.kwDel) {
      const [kind, i] = d.kwDel.split(":");
      state.keywords[kind].splice(Number(i), 1);
      keywordsChanged(); return;
    }

    const t = d.id && tenders.find((x) => x.id === d.id);
    switch (d.action) {
      case "close-drawer": closeDrawer(); break;
      case "toggle-relevant": state.f.onlyRelevant = !state.f.onlyRelevant; saveFilters(); render(); break;
      case "clear-filters": state.f = { src: [], cat: "", city: "", onlyRelevant: false, sort: state.f.sort }; saveFilters(); render(); break;
      case "export-csv": exportCsv(); break;
      case "ics": if (t) { download(`ihale_${refOf(t).replace(/[^\w-]/g, "_")}.ics`, icsFor([t]), "text/calendar"); toast("Takvim dosyası indirildi (3 gün + 1 gün önce hatırlatma)"); } break;
      case "export-ics-all": download("takip_listem.ics", icsFor(tenders.filter((x) => state.watch[x.id])), "text/calendar"); break;
      case "copy":
        if (t) {
          const txt = `${t.title}\nİdare: ${t.authority}\n${t.dateKind || "İhale tarihi"}: ${whenText(t)} (${countdown(t.tenderDate)} kaldı)\nİKN / Ref: ${refOf(t)}\nÖzet: ${t.summary}\n${t.ekapUrl ? "EKAP: " + t.ekapUrl + "\n" : ""}İlan: ${t.ilanUrl || t.url || ""}`;
          navigator.clipboard?.writeText(txt).then(() => toast("Özet panoya kopyalandı"), () => toast("Kopyalanamadı"));
        }
        break;
      case "reset-kw":
        if (confirm("Paneldeki kaydedilmemiş/taranmamış kelime değişiklikleri atılsın ve son taramadaki listeye dönülsün mü?")) {
          state.keywords = JSON.parse(JSON.stringify(DEFAULT_KEYWORDS)); keywordsChanged();
        }
        break;
      case "kw-connect": connectFolder(); break;
      case "kw-sync": syncKeywords(false); break;
      case "kw-download": download("keywords.json", kwFileContent(), "application/json"); toast("keywords.json indirildi — Tender Radar\\scraper klasörüne kopyala"); break;
      case "reload-now": checkVersion(true); break;
      case "scan-now": if (CLOUD) requestScan(); break;
      case "pin-rival": {
        const p = prefs(); const set = new Set(p.rivals || []);
        set.has(d.name) ? set.delete(d.name) : set.add(d.name);
        p.rivals = [...set]; savePrefs(p); toast(set.has(d.name) ? "Rakip takibe alındı — haberleri Sabah Özeti'nde" : "Rakip takipten çıkarıldı"); render();
        break;
      }
      case "history-import": $("#historyFile")?.click(); break;
      case "sign-out": if (CLOUD && confirm("Çıkış yapılsın mı?")) CLOUD.signOut(); break;
      case "clear-new": newIds = new Set(); store.set("newIds", []); showNewBanner(); render(); break;
      case "export-settings":
        download(`tender-radar-yedek_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ keywords: state.keywords, watch: state.watch, crm }, null, 2), "application/json");
        break;
      case "import-settings": $("#importFile")?.click(); break;
      case "toggle-news-relevant": state.newsRelevant = !state.newsRelevant; store.set("newsRelevant", state.newsRelevant); render(); break;
      case "print": window.print(); break;
      case "copy-morning":
        navigator.clipboard?.writeText(morningText()).then(() => toast("Sabah özeti panoya kopyalandı (Teams / e-postaya yapıştırabilirsin)"), () => toast("Kopyalanamadı"));
        break;
    }

    // ---- Müşteri kartı eylemleri
    if (d.seg !== undefined) { state.custFilter.seg = d.seg; store.set("custFilter", state.custFilter); render(); return; }
    const key = d.key;
    switch (d.crm) {
      case "show-add": state.showAddCustomer = !state.showAddCustomer; render(); if (state.showAddCustomer) $('[data-crm-form="add-customer"] input')?.focus(); break;
      case "toggle-pinned-filter": state.custFilter.pinned = !state.custFilter.pinned; store.set("custFilter", state.custFilter); render(); break;
      case "pin": crmOf(key).pinned = !crmOf(key).pinned; saveCrm(); invalidateCustomers(); render(); break;
      case "del-contact": crmOf(key).contacts.splice(Number(d.i), 1); saveCrm(); invalidateCustomers(); render(); break;
      case "del-log":
        if (confirm("Bu görüşme kaydı silinsin mi?")) { const c = crmOf(key); c.log = c.log.filter((l) => l.id !== d.id); saveCrm(); invalidateCustomers(); render(); }
        break;
      case "delete-customer":
        if (confirm("Bu müşteri kartı ve tüm notları silinsin mi?")) { delete crm[key]; saveCrm(); invalidateCustomers(); location.hash = "#/musteriler"; }
        break;
      case "ics": {
        const c = customers().find((x) => x.key === key);
        if (c && c.crm.nextDate) {
          const start = c.crm.nextDate.replace(/-/g, "");
          const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tender Radar//TR", "BEGIN:VEVENT", `UID:crm-${Date.now()}@tender-radar`,
            `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`, `DTSTART;VALUE=DATE:${start}`,
            `SUMMARY:${c.displayName}: ${c.crm.nextStep || "Sonraki adım"}`.replace(/[,;]/g, (m) => "\\" + m), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
          download(`aksiyon_${start}.ics`, ics, "text/calendar");
        }
        break;
      }
    }
  });

  function morningText() {
    const live = tenders.filter((t) => !t.isCancelled && daysLeft(t.tenderDate) >= 0 && relevance(t).score >= 0)
      .sort((a, b) => new Date(a.tenderDate) - new Date(b.tenderDate));
    const line = (t) => `• ${t.title} — ${t.authority} | ${t.dateKind || "İhale"}: ${whenText(t)} (${countdown(t.tenderDate)}) | ${t.url}`;
    const in2 = live.filter((t) => daysLeft(t.tenderDate) < 2);
    const fresh = live.filter((t) => t.firstSeen && Date.now() - new Date(t.firstSeen) < 26 * 3600000 && !in2.includes(t));
    const week = live.filter((t) => { const x = daysLeft(t.tenderDate); return x >= 2 && x <= 7; });
    const nd = deals.filter((x) => Date.now() - new Date(x.date) < 3 * DAY);
    return [
      `TENDER RADAR — SABAH ÖZETİ (${new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })})`, "",
      `SON GÜN BUGÜN/YARIN (${in2.length})`, ...in2.map(line), "",
      `YENİ GELEN İHALELER (${fresh.length})`, ...fresh.map(line), "",
      `BU HAFTA (${week.length})`, ...week.map(line), "",
      `YENİ SÖZLEŞMELER / SONUÇLAR (${nd.length})`, ...nd.map((x) => `• ${x.winner} — ${x.subject} | ${fmtMoney(x.amount)} | ${x.url}`)
    ].join("\n");
  }

  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.filter) { state.f[el.dataset.filter] = el.value; saveFilters(); render(); }
    if (el.dataset.status) { state.watch[el.dataset.status].status = el.value; saveWatch(); render(); toast("Durum güncellendi"); }
    if (el.dataset.custsort !== undefined) { state.custFilter.sort = el.value; store.set("custFilter", state.custFilter); render(); }
    if (el.dataset.inst) { state.instFilter[el.dataset.inst] = el.dataset.inst === "top" ? Number(el.value) : el.value; store.set("instFilter", state.instFilter); render(); }
    if (el.dataset.map) { state.mapFilter[el.dataset.map] = el.value; store.set("mapFilter", state.mapFilter); render(); }
    if (el.dataset.notify) {
      const p = prefs(); p.notify = { daily: true, reminders: true, scope: "watch", email: "", ...(p.notify || {}) };
      p.notify[el.dataset.notify] = el.type === "checkbox" ? el.checked : el.value.trim();
      savePrefs(p); toast("Bildirim ayarı kaydedildi");
    }
    if (el.id === "historyFile" && el.files.length) {
      Promise.all([...el.files].map((file) => file.text().then((txt) => [file.name.toLowerCase(), JSON.parse(txt)]))).then(async (files) => {
        const payload = {};
        for (const [name, json] of files) {
          const list = Array.isArray(json) ? json : null;
          if (!list) continue;
          if (name.includes("tender")) payload.tenders = list;
          else if (name.includes("deal")) payload.deals = list;
          else if (name.includes("news")) payload.news = list;
        }
        if (!Object.keys(payload).length) { toast("Tanınan dosya yok: scraper\\store içindeki tenders.json, news.json, deals.json dosyalarını seç"); return; }
        await CLOUD.importHistory(payload);
        toast(`Geçmiş yüklendi (${Object.entries(payload).map(([k, v]) => `${k}: ${v.length}`).join(", ")}) — bir sonraki taramada (~10–15 dk) birleştirilecek`);
      }).catch((err) => toast("Dosyalar okunamadı: " + err.message));
      el.value = "";
    }
    if (el.dataset.crmField) {
      crmOf(el.dataset.key)[el.dataset.crmField] = el.value.trim();
      saveCrm(); invalidateCustomers();
      if (["nextDate", "segment", "city", "aliases", "potential"].includes(el.dataset.crmField)) render();
      toast("Kaydedildi");
    }
    if (el.id === "importFile" && el.files[0]) {
      el.files[0].text().then((txt) => {
        try {
          const j = JSON.parse(txt);
          if (j.keywords) { state.keywords = { pos: j.keywords.pos || [], neg: j.keywords.neg || [] }; keywordsChanged(); }
          if (j.watch) { state.watch = j.watch; saveWatch(); }
          if (j.crm) { Object.keys(crm).forEach((k) => delete crm[k]); Object.assign(crm, j.crm); saveCrm(); invalidateCustomers(); }
          render(); toast("Yedek geri yüklendi");
        } catch { toast("Dosya okunamadı"); }
      });
    }
  });
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.note) { state.watch[el.dataset.note].note = el.value; saveWatch(); }
    if (el.dataset.crmField === "notes" || el.dataset.crmField === "nextStep") { crmOf(el.dataset.key)[el.dataset.crmField] = el.value; saveCrm(); invalidateCustomers(); }
  });
  document.addEventListener("submit", (e) => {
    const crmForm = e.target.closest("[data-crm-form]");
    if (crmForm) {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(crmForm).entries());
      const kind = crmForm.dataset.crmForm;
      if (kind === "add-customer") {
        const key = customerKey(fd.name);
        if (!key) return;
        Object.assign(crmOf(key), { manual: true, name: fd.name.trim(), segment: fd.segment, city: fd.city.trim() });
        saveCrm(); invalidateCustomers(); state.showAddCustomer = false;
        location.hash = "#/musteri/" + encodeURIComponent(key);
      } else if (kind === "contact") {
        crmOf(crmForm.dataset.key).contacts.push({ name: fd.name.trim(), title: fd.title.trim(), phone: fd.phone.trim(), email: fd.email.trim() });
        saveCrm(); invalidateCustomers(); render(); toast("Kişi eklendi");
      } else if (kind === "log") {
        crmOf(crmForm.dataset.key).log.push({ id: String(Date.now()), date: fd.date, type: fd.type, text: fd.text.trim() });
        saveCrm(); invalidateCustomers(); render(); toast("Görüşme kaydedildi");
      }
      return;
    }
    const form = e.target.closest("[data-kw-add]");
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.kwAdd;
    const val = form.kw.value.trim();
    if (val && !state.keywords[kind].some((k) => fold(k) === fold(val))) {
      state.keywords[kind].push(val);
      keywordsChanged();
      $(`[data-kw-add="${kind}"] input`)?.focus();
    } else if (val) { toast("Bu kelime zaten listede"); }
  });

  const search = $("#globalSearch");
  search.addEventListener("input", () => {
    state.q = search.value.trim();
    if (!["ihaleler", "piyasa", "ozet", "musteriler"].includes(state.view)) { location.hash = "#/ihaleler"; return; }
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); search.focus(); }
    if (e.key === "Escape") closeDrawer();
  });
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  $("#menuToggle").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

  // Tema
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(store.get("theme", null));
  $("#themeToggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next); store.set("theme", next);
  });

  // Başlangıç
  $("#todayLabel").textContent = new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("#demoBanner").hidden = !(DATA.demo || (CLOUD && !tenders.length && !DATA.generatedAt));
  if (CLOUD) {
    const ub = $("#userBox");
    ub.innerHTML = `<span title="${esc(CLOUD.user.email || "")}">👤 ${esc(CLOUD.username)}</span><button class="btn ghost small" data-action="sign-out" type="button">Çıkış</button>`;
    ub.hidden = false;
    CLOUD.onSyncError = (m) => toast("Buluta kaydedilemedi: " + m + " — bağlantı gelince tekrar denenecek");
  }
  if (DATA.generatedAt) $("#dataStamp").textContent = "Veri: " + fmtDate(DATA.generatedAt);
  window.addEventListener("hashchange", route);
  purgeDismissed();   // tarihi 3 günden fazla geçmiş "çıkarılanlar" kaydını temizle
  document.addEventListener("toggle", (e) => { if (e.target.matches && e.target.matches("[data-toggle-dismissed]")) state.openDismissed = e.target.open; }, true);
  updateNavCounts();
  route();
  showNewBanner();

  // Yeni veri kontrolü: dakikada bir + sekmeye geri dönüldüğünde
  setInterval(pollVersion, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollVersion(); });

  // Geri sayımlar dakikada bir tazelenir (çekmece açıkken ve yazı yazarken dokunma)
  setInterval(() => {
    if (!$("#drawer").classList.contains("open") && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) render();
  }, 60000);
})();
