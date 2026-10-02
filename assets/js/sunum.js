/*
 * Bid / No-Bid sunumu (PowerPoint .pptx)
 * Proje özetinden yönetici sunumu üretir: ihale adı ve tarihi, işin genel kapsamı, finansal riskler, genel proje riskleri.
 * Cümleler kısaltılmaz; bir slayta sığmayan içerik "(devam)" slaydına geçer.
 * PptxGenJS ilk kullanımda yüklenir; dosya tarayıcıda üretilip indirilir.
 */
(function () {
  "use strict";

  const LIB = "https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js";
  const AUTHOR = "Muhammet Emin Gülay";
  const C = { navy: "1F3864", ink: "262626", text: "404040", grey: "7F7F7F", line: "D9D9D9", fill: "F2F2F2", white: "FFFFFF", accent: "2F5496" };
  const FONT = "Calibri";
  const W = 13.333, H = 7.5, M = 0.6;

  let loading = null;
  function load() {
    if (window.PptxGenJS) return Promise.resolve();
    return loading || (loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = LIB; s.onload = res; s.onerror = () => { loading = null; rej(new Error("Sunum kütüphanesi yüklenemedi (internet bağlantısını kontrol et)")); };
      document.head.appendChild(s);
    }));
  }

  // ---- Metin yardımcıları
  const RX_CITE = /\s*\((?=[^()]{2,140}\))[^()]*?(?:Ş\.|[Şş]artname|[Ss]özleşme|[Cc]etvel|İlan|[Zz]eyilname|[Tt]asar|\bmd\.|[Mm]adde|\bs\.\s?\d|[Ss]ayfa|\bEk[- ]?\d|[Kk]alem\s?\d)[^()]*\)/g;
  const fold = (s) => String(s || "").toLocaleLowerCase("tr-TR").replace(/[çğıöşüâîû]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" }[c]));
  const useful = (v) => v != null && String(v).trim() !== "" && !/^(belirtilmemiş|bilinmiyor|yok|-|—)\.?$/i.test(String(v).trim());
  // Sunum metni: atıfları ve araç dilini çıkar, cümleyi TAM bırak (kısaltma yok), sonuna nokta koy
  function full(s) {
    let t = String(s || "").replace(RX_CITE, "").replace(/[^.]*yapay zekâ[^.]*\.?/gi, "").replace(/…+\s*$/, "")
      .replace(/^[A-ZÇĞİÖŞÜa-zçğıöşü ]{0,30}?\b\d{1,2}(?:\.\d{1,2}){1,3}\.\s+/u, "")   // "Ödeme yeri 12.1.1. …" gibi madde numarası kalıntısı
      .replace(/\s+/g, " ").trim().replace(/\s+([.,;:])/g, "$1");
    t = t.replace(/[,;:\s]+$/, "");
    if (t && !/[.!?]$/.test(t)) t += ".";
    return t.charAt(0).toLocaleUpperCase("tr-TR") + t.slice(1);
  }
  // Aynı anlamdaki maddeleri ayıkla (kelime kümesi benzerliği)
  const words = (s) => new Set(fold(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  function similar(a, b) {
    const A = words(a), B = words(b);
    if (!A.size || !B.size) return false;
    let n = 0; A.forEach((w) => { if (B.has(w)) n++; });
    return n / Math.min(A.size, B.size) >= 0.7;
  }
  const fmtDate = (d, time) => (d ? new Date(d).toLocaleString("tr-TR", time ? { dateStyle: "long", timeStyle: "short" } : { dateStyle: "long" }) : "");

  // ---- Risk sınıflandırma
  // Finansal: para akışını doğrudan etkileyen ifadeler ("birim fiyat cetveli" gibi doküman adları sayılmaz)
  const FIN_WORDS = /teminat|fiyat fark|avans|ceza|ödeme|hakediş|\bkur\b|döviz|maliyet|finans|nakit|sigorta|vergi|damga|kdv|kâr\b|zarar|nakde|bütçe|fiyat artış|enflasyon/i;
  const DOC_ISSUE = /çelişk|uyumsuz|uyuşma|tutarsız|zıt|farklı ihale|alakasız|belirsiz|okunama|eksik doküman/i;
  const isFin = (s) => { const v = String(s).replace(/birim fiyat (teklif )?cetvel\w*|teklif cetvel\w*/gi, ""); return !DOC_ISSUE.test(v) && FIN_WORDS.test(v); };
  const FIN_LABEL = [[/ödeme|hakediş/i, "Ödeme"], [/teminat/i, "Teminat"], [/fiyat fark|\bkur\b|döviz|fiyat artış|enflasyon/i, "Fiyat / kur riski"], [/avans|nakit|finans/i, "Nakit akışı"],
    [/arıza|müdahale|garanti|kronik|bila ?bedel/i, "Garanti cezası"], [/ceza/i, "Ceza"], [/işçilik|personel|isg|ekip/i, "İşçilik maliyeti"],
    [/sigorta|vergi|damga|kdv/i, "Ek maliyet"], [/götürü|metraj|miktar/i, "Miktar riski"], [/.*/, "Maliyet"]];
  const PRJ_LABEL = [[DOC_ISSUE, "Doküman"], [/süre|takvim|gün\b|termin|teslim/i, "Süre"], [/marka|muadil|rekabet/i, "Rekabet"], [/deneyim|benzer iş|yeterlik|referans/i, "Yeterlik"],
    [/garanti|bakım|yedek parça/i, "Garanti / bakım"], [/alt yüklenici|sözleşme|yükümlülük|sorumluluk/i, "Sözleşme"],
    [/teknik|protokol|entegrasyon|uyumlu|scada|plc|rtu|yazılım|donanım|test|kabul|devreye/i, "Teknik"], [/.*/, "Proje"]];
  const labelOf = (txt, table) => table.find(([rx]) => rx.test(txt))[1];

  function collect(t, rec) {
    const s = rec.summary || {}, f = s.fields || {}, tech = s.tech || {}, ai = rec.ai || {};
    const K = ai.kunye || {};
    const tidyName = (window.TR_PROJE && window.TR_PROJE.core.tidyItemName) || ((x) => x);

    // Risk listeleri: önem sırası = ekleme sırası; benzer maddeler tekrar eklenmez
    const fin = [], prj = [];
    const all = [];
    const push = (list, label, text) => {
      const v = full(text);
      if (!useful(v) || v.length < 8) return;
      if (all.some((x) => similar(x, v))) return;
      all.push(v); list.push({ label, text: v });
    };
    // Yalnızca aynı bilgiyi tekrar eden maddeler atlanır (ör. "gecikme cezası %0,01"); başka cezalar/riskler kalır
    const covered = (r) => (f.ceza && /gecikme cezas|gecikilen (her )?(takvim )?gün/i.test(r) && !/kronik|arıza|müdahale|performans/i.test(r)) ||
      (f.fiyatFarki && /^[^.]{0,40}fiyat farkı[^.]{0,30}(verilmeyecek|ödenmeyecek|verilecek|uygulanmayacak|öngörülmemiş)[^.]{0,40}\.?$/i.test(r)) ||
      (f.avans && /^[^.]{0,40}avans[^.]{0,30}(verilmeyecek|ödenmeyecek|verilecek|öngörülmemiş)[^.]{0,40}\.?$/i.test(r)) ||
      ((f.gecici || f.kesin) && /(geçici|kesin) teminat[^.]*%/i.test(r) && !/irat|nakde/i.test(r));

    // ---------- Finansal (en önemliler önce)
    // Ödeme: özetin tüm dokümanlardan derlediği açıklama daha kapsamlıdır; yoksa dokümandaki ödeme maddesi
    const odeme = (useful(ai.odeme_sartlari) ? ai.odeme_sartlari : "") || f.odeme?.v || "";
    if (odeme) push(fin, "Ödeme", odeme);
    if (f.gecici || f.kesin) push(fin, "Teminat", [f.gecici && `Geçici teminat ${f.gecici.v}`, f.kesin && `kesin teminat ${f.kesin.v}`].filter(Boolean).join(", ") + "; teklif ve sözleşme aşamasında banka teminat limiti gerekir.");
    if (f.fiyatFarki) push(fin, "Fiyat / kur riski", f.fiyatFarki.v === "Verilmeyecek" ? "Fiyat farkı verilmeyecek; kur ve malzeme fiyat artışları yükleniciye ait." : "Fiyat farkı verilecek; kur ve malzeme artışları kısmen karşılanır.");
    if (f.avans) push(fin, "Nakit akışı", f.avans.v === "Verilmeyecek" ? "Avans verilmeyecek; tedarik ve imalat dönemi öz kaynakla finanse edilecek." : "Avans verilecek; avans teminatı gerekir.");
    if (f.ceza) push(fin, "Ceza", `Gecikme cezası: gecikilen her gün için ${f.ceza.v}.`);
    if (/götürü/i.test(f.sozTuru?.v || "")) push(fin, "Miktar riski", `${f.sozTuru.v} sözleşme; miktar ve metraj farkları yükleniciye ait.`);
    for (const r of ai.riskler || []) if (isFin(r) && !covered(r)) push(fin, labelOf(r, FIN_LABEL), r);
    for (const r of ai.yeterlik_ve_mali_sartlar || []) if (isFin(r) && /ceza|avans|fiyat fark|ödeme|hakediş|sigorta|kesinti/i.test(r) && !covered(r)) push(fin, labelOf(r, FIN_LABEL), r);

    // ---------- Genel proje (en önemliler önce)
    const sure = (f.sure || f.teslimSure)?.v || (useful(ai.proje_suresi) ? ai.proje_suresi : "") || (useful(K.sure) ? K.sure : "");
    const tDate = t.tenderDate ? new Date(t.tenderDate) : null;
    const days = tDate ? Math.ceil((tDate - Date.now()) / 864e5) : null;
    // Proje süresi: ara terminleriyle birlikte özetteki açıklama; yoksa dokümandaki süre
    const sureDetay = useful(ai.proje_suresi) ? ai.proje_suresi : "";
    if (sureDetay) push(prj, "Proje süresi", sureDetay);
    else if (sure) push(prj, "Proje süresi", `İşin süresi: ${String(sure).replace(/\.$/, "")}; termin planı ve tedarik süreleri buna göre kurulmalı.`);
    if (days != null && days >= 0 && days <= 10) push(prj, "Teklif süresi", `İhaleye ${days} gün kaldı; teklif hazırlık süresi kısa.`);
    // Yapay zekâ risklerinin finansal olmayanları (önem sırasıyla gelir)
    for (const r of ai.riskler || []) if (!isFin(r)) push(prj, labelOf(r, PRJ_LABEL), r);
    if (f.deneyim) push(prj, "Yeterlik", `İş deneyimi: teklif bedelinin asgari ${f.deneyim.v} oranında${f.benzerIs ? `; benzer iş: ${String(f.benzerIs.v).replace(/\.$/, "")}` : ""}.`);
    if ((tech.brands || []).length && !tech.muadil) push(prj, "Rekabet", `Şartnamede marka belirtilmiş (${tech.brands.slice(0, 3).map((b) => b.k).join(", ")}), muadil ifadesi bulunmuyor.`);
    if (f.garanti) push(prj, "Garanti / bakım", `Garanti süresi ${f.garanti.v}${f.yedek ? `; ${String(f.yedek.v).replace(/\.$/, "")}` : ""}.`);
    if (f.altYuk && /(yaptırılamaz|verilemez|çalıştırılamaz|izin verilmemektedir)/.test(f.altYuk.v)) push(prj, "Sözleşme", "Alt yüklenici kullanımı kısıtlı; işin tamamı firma kaynaklarıyla yürütülmeli.");
    if (f.fat || f.sat) push(prj, "Teknik", `${[f.fat && "Fabrika kabul testi (FAT)", f.sat && "saha kabul testi (SAT)"].filter(Boolean).join(" ve ")} yapılacak; test süreleri termine dahil edilmeli.`);
    if ((s.missing || []).length) push(prj, "Doküman", `İncelenmeyen doküman: ${s.missing.map((m) => ({ idari: "idari şartname", teknik: "teknik şartname", cetvel: "birim fiyat cetveli", sozlesme: "sözleşme tasarısı" }[m] || m)).join(", ")}.`);
    const unread = (ai.okunamayan_kisimlar || []).length + (ai.skipped || []).length || (s.unread || []).length;
    if (unread) push(prj, "Doküman", `${unread} doküman/bölüm okunamadı; ilgili kısımlar dokümanın aslından kontrol edilmeli.`);

    // ---------- Kapsam: tüm farklı maddeler (tekrarsız)
    const scope = [];
    const addScope = (x) => { const v = full(x); if (useful(v) && v.length > 12 && !scope.some((y) => similar(y, v))) scope.push(v); };
    (ai.kapsam || []).forEach(addScope);
    if (tech.scope) {
      const parts = tech.scope.v.split(/(?<=[.;])\s+(?=[A-ZÇĞİÖŞÜ0-9])/u);
      if (/…\s*$/.test(tech.scope.v)) parts.pop();   // kaynak metin kısaltılmışsa yarım kalan son cümleyi alma
      parts.filter((x) => x.length > 30).forEach(addScope);
    }
    (ai.teknik_gereksinimler || []).filter((x) => /kurul|temin|montaj|entegrasyon|devreye|yazılım|eğitim|kabul|teslim/i.test(x)).forEach(addScope);
    if (f.miktar && !/ayrıntılı bilgi/i.test(f.miktar.v)) addScope(f.miktar.v);
    const items = (s.items || []).length ? s.items : (ai.ana_kalemler || []).map((i) => ({ name: i.ad, qty: i.miktar, unit: i.birim }));
    if (items.length) {
      const top = items.slice(0, 6).map((i) => `${tidyName(i.name)} (${typeof i.qty === "number" ? i.qty.toLocaleString("tr-TR") : i.qty}${i.unit ? " " + i.unit : ""})`);
      scope.push(full(`Ana kalemler: ${top.join("; ")}${items.length > 6 ? ` ve ${items.length - 6} kalem daha` : ""}`));
    }

    // ---------- Temel bilgiler
    const TUR_RX = [[/danışman/i, "Danışmanlık hizmeti"], [/yapım/i, "Yapım işi"], [/hizmet/i, "Hizmet alımı"], [/\bmal\b|mal alım|\balım/i, "Mal alımı"]];
    const turOf = (v) => { for (const [rx, l] of TUR_RX) if (rx.test(String(v || ""))) return l; return ""; };
    const tur = f.tur?.v || turOf(t.tur) || turOf((t.categories || []).find((c) => /alım|hizmet|yapım|danışman|\bmal\b/i.test(c))) || turOf(K.ihale_turu_usulu) || turOf(t.title);
    const nice = (v) => String(v || "").replace(RX_CITE, "").replace(/\s+/g, " ").trim();
    const facts = [
      ["İdare", f.idare?.v || t.authority],
      ["İş yeri", f.yer?.v || (useful(K.yer) ? K.yer : t.city)],
      ["Proje süresi", sure],
      ["Kalem sayısı", (s.items || []).length ? `${s.items.length} kalem` : (useful(K.kalem_sayisi) ? K.kalem_sayisi : "")],
      ["Sözleşme türü", f.sozTuru?.v || (useful(K.sozlesme_turu) ? K.sozlesme_turu : "")],
      ["Teklif şekli", f.eteklif ? "e-teklif (EKAP)" : ""]
    ].filter(([, v]) => useful(v)).map(([k, v]) => [k, nice(v)]);

    return {
      title: f.isAdi?.v || (useful(K.isin_adi) ? nice(K.isin_adi) : "") || t.title || "İhale",
      idare: f.idare?.v || t.authority || "",
      tDate, days, tur, usul: f.usul?.v || t.procedure || "",
      dateText: f.tarih?.v || (tDate ? fmtDate(tDate, true) : ""),
      ref: t.ikn ? `İKN ${t.ikn}` : t.refNo || "",
      status: t.isCancelled ? "İptal edildi" : tDate ? (tDate > new Date() ? "Devam ediyor" : "İhale tarihi geçti") : "",
      scope, facts, fin, prj
    };
  }

  // Metin yüksekliği tahmini (inç): karakter/satır ve satır yüksekliği yazı boyutuna göre
  const estLines = (text, charsPerLine) => Math.max(1, Math.ceil(String(text).length / charsPerLine));

  async function build({ tender: t, rec }) {
    await load();
    const d = collect(t, rec);
    const pptx = new window.PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = AUTHOR; pptx.company = ""; pptx.title = `Bid / No-Bid — ${d.title}`;
    const now = new Date();
    const footerText = `Hazırlayan: ${AUTHOR}   |   ${fmtDate(now)}`;
    let pageNo = 0;

    function frame(slide, title, sub) {
      pageNo++;
      slide.background = { color: C.white };
      slide.addText("BID / NO-BID DEĞERLENDİRMESİ", { x: M, y: 0.35, w: 8, h: 0.3, fontFace: FONT, fontSize: 10, color: C.grey, bold: true, charSpacing: 2 });
      slide.addText(title, { x: M, y: 0.62, w: W - 2 * M, h: 0.6, fontFace: FONT, fontSize: 26, color: C.navy, bold: true });
      if (sub) slide.addText(sub, { x: M, y: 1.2, w: W - 2 * M, h: 0.35, fontFace: FONT, fontSize: 13, color: C.grey });
      slide.addShape(pptx.ShapeType.line, { x: M, y: sub ? 1.62 : 1.32, w: W - 2 * M, h: 0, line: { color: C.navy, width: 1.25 } });
      slide.addShape(pptx.ShapeType.line, { x: M, y: H - 0.55, w: W - 2 * M, h: 0, line: { color: C.line, width: 0.75 } });
      slide.addText(footerText, { x: M, y: H - 0.5, w: 8, h: 0.3, fontFace: FONT, fontSize: 9, color: C.grey });
      slide.addText(`${d.ref ? d.ref + "   |   " : ""}${pageNo}`, { x: W - M - 4, y: H - 0.5, w: 4, h: 0.3, fontFace: FONT, fontSize: 9, color: C.grey, align: "right" });
    }

    // Sayfalama: öğeler sırayla slaytlara dağıtılır. Son slayt çok boş kalacaksa (tek-iki kısa madde),
    // ayrı slayt açmak yerine önceki slayta sığdırılır ve o slaytta yazı bir miktar küçültülür.
    // heightOf(item, scale, pageIndex) → inç;  avail(pageIndex) → kullanılabilir yükseklik
    function paginate(items, heightOf, avail) {
      const pages = [];
      let cur = [], used = 0;
      for (const it of items) {
        const pi = pages.length, h = heightOf(it, 1, pi);
        if (cur.length && used + h > avail(pi)) { pages.push({ items: cur, scale: 1 }); cur = []; used = 0; }
        cur.push(it); used += heightOf(it, 1, pages.length);
      }
      pages.push({ items: cur, scale: 1 });
      if (pages.length > 1) {
        const li = pages.length - 1, last = pages[li], prev = pages[li - 1];
        const lastUsed = last.items.reduce((a, x) => a + heightOf(x, 1, li), 0);
        if (lastUsed < avail(li) * 0.3) {
          for (const sc of [0.92, 0.85]) {
            const merged = [...prev.items, ...last.items];
            if (merged.reduce((a, x) => a + heightOf(x, sc, li - 1), 0) <= avail(li - 1)) { pages.splice(li - 1, 2, { items: merged, scale: sc }); break; }
          }
        }
      }
      return pages;
    }
    // Karakter/inç (Calibri): 15 pt ≈ 11,5; 14 pt ≈ 12,3 — küçültmede oransal artar
    const CPI15 = 11.5, CPI14 = 12.3;

    // Risk satırları: her satırın yüksekliği metnine göre; sığmayanlar "(devam)" slaydına
    function riskSlides(title, list, emptyMsg) {
      const y0 = 1.6, yMax = H - 0.75, textW = W - 2 * M - 2.95;
      const rowH = (r, sc = 1) => Math.max(0.55 * sc, estLines(r.text, Math.floor(textW * CPI14 / sc)) * 0.245 * sc + 0.26 * sc);
      const pages = list.length ? paginate(list, (r, sc) => rowH(r, sc), () => yMax - y0) : [{ items: [], scale: 1 }];
      pages.forEach((pg, pi) => {
        const sl = pptx.addSlide();
        frame(sl, pi ? `${title} (devam)` : title);
        if (!pg.items.length) { sl.addText(emptyMsg, { x: M, y: y0, w: W - 2 * M, h: 0.5, fontFace: FONT, fontSize: 16, color: C.grey, italic: true }); return; }
        const fs = Math.round(14 * pg.scale * 2) / 2;
        let y = y0;
        pg.items.forEach((r, i) => {
          const h = rowH(r, pg.scale);
          sl.addShape(pptx.ShapeType.rect, { x: M, y: y + 0.1, w: 0.08, h: h - 0.2, fill: { color: C.navy }, line: { color: C.navy, width: 0 } });
          sl.addText(r.label, { x: M + 0.25, y, w: 2.6, h, fontFace: FONT, fontSize: fs, bold: true, color: C.navy, valign: "middle" });
          sl.addText(r.text, { x: M + 2.95, y, w: textW, h, fontFace: FONT, fontSize: fs, color: C.text, valign: "middle", margin: 0.05 });
          if (i < pg.items.length - 1) sl.addShape(pptx.ShapeType.line, { x: M + 0.25, y: y + h, w: W - 2 * M - 0.25, h: 0, line: { color: C.line, width: 0.5 } });
          y += h;
        });
      });
    }

    // 1) Kapak: ihale adı ve tarihi
    {
      const s1 = pptx.addSlide();
      pageNo++;
      s1.background = { color: C.white };
      s1.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.28, h: H, fill: { color: C.navy }, line: { color: C.navy, width: 0 } });
      s1.addText("BID / NO-BID DEĞERLENDİRMESİ", { x: 1.0, y: 1.05, w: 11, h: 0.4, fontFace: FONT, fontSize: 13, color: C.grey, bold: true, charSpacing: 3 });
      const titleSize = d.title.length > 110 ? 24 : d.title.length > 70 ? 28 : 34;
      s1.addText(d.title, { x: 1.0, y: 1.45, w: 11.3, h: 1.6, fontFace: FONT, fontSize: titleSize, color: C.navy, bold: true, valign: "bottom" });
      s1.addText(d.idare, { x: 1.0, y: 3.1, w: 11.3, h: 0.7, fontFace: FONT, fontSize: d.idare.length > 90 ? 15 : 18, color: C.ink, valign: "top" });
      s1.addShape(pptx.ShapeType.line, { x: 1.0, y: 3.95, w: 11.3, h: 0, line: { color: C.navy, width: 1.5 } });
      const tiles = [["İHALE TARİHİ", d.dateText || "—"], ["KALAN SÜRE", d.days == null ? "—" : d.days < 0 ? "Tarihi geçti" : d.days === 0 ? "Bugün" : `${d.days} gün`],
        ["İHALE TÜRÜ / USUL", [d.tur, d.usul].filter(Boolean).join(" · ") || "—"], ["DURUM", d.status || "—"]];
      const tw = 11.3 / 4;
      tiles.forEach(([k, v], i) => {
        s1.addText(k, { x: 1.0 + i * tw, y: 4.2, w: tw - 0.2, h: 0.35, fontFace: FONT, fontSize: 11, color: C.grey, bold: true, charSpacing: 1 });
        s1.addText(v, { x: 1.0 + i * tw, y: 4.55, w: tw - 0.2, h: 0.8, fontFace: FONT, fontSize: v.length > 24 ? 15 : 18, color: C.ink, bold: true, valign: "top" });
      });
      if (d.ref) s1.addText(d.ref, { x: 1.0, y: 5.5, w: 6, h: 0.35, fontFace: FONT, fontSize: 12, color: C.grey });
      s1.addText(`Hazırlayan: ${AUTHOR}`, { x: 1.0, y: H - 1.05, w: 7, h: 0.35, fontFace: FONT, fontSize: 13, color: C.ink, bold: true });
      s1.addText(fmtDate(now), { x: 1.0, y: H - 0.72, w: 7, h: 0.3, fontFace: FONT, fontSize: 12, color: C.grey });
    }

    // 2) İşin genel kapsamı (+ gerekirse devam slaytları); ilk slaytta sağda temel bilgiler paneli
    {
      const y0 = 1.95, yMax = H - 0.8, panelW = 4.3;
      const firstW = W - 2 * M - panelW - 0.4, contW = W - 2 * M;
      const widthOf = (pi) => (pi ? contW : firstW) - 0.35;   // madde işareti girintisi
      const bulletH = (x, sc, pi) => estLines(x, Math.floor(widthOf(pi) * CPI15 / sc)) * 0.255 * sc + 0.12 * sc;
      const pages = paginate(d.scope, bulletH, () => yMax - y0 - 0.1);
      pages.forEach((pg, pi) => {
        const sl = pptx.addSlide();
        frame(sl, pi ? "İşin Genel Kapsamı (devam)" : "İşin Genel Kapsamı", d.idare);
        pg.w = pi ? contW : firstW;
        if (pg.items.length) sl.addText(pg.items.map((x) => ({ text: x, options: { bullet: { code: "25AA" }, paraSpaceAfter: Math.round(8 * pg.scale) } })),
          { x: M, y: y0, w: pg.w, h: yMax - y0, fontFace: FONT, fontSize: Math.round(15 * pg.scale * 2) / 2, color: C.text, valign: "top" });
        else if (!pi) sl.addText("Kapsam bilgisi dokümanlarda bulunamadı.", { x: M, y: y0, w: pg.w, h: 0.5, fontFace: FONT, fontSize: 16, color: C.grey, italic: true });
        if (pi) return;
        const px = W - M - panelW;
        sl.addShape(pptx.ShapeType.rect, { x: px, y: y0, w: panelW, h: yMax - y0, fill: { color: C.fill }, line: { color: C.fill, width: 0 } });
        sl.addText("TEMEL BİLGİLER", { x: px + 0.3, y: y0 + 0.2, w: panelW - 0.6, h: 0.35, fontFace: FONT, fontSize: 11, color: C.grey, bold: true, charSpacing: 1 });
        let fy = y0 + 0.65;
        for (const [k, v] of d.facts) {
          const size = v.length > 110 ? 11 : 13;
          const lines = estLines(v, size === 11 ? 50 : 42);
          const fh = 0.26 + lines * (size === 11 ? 0.21 : 0.25) + 0.1;
          if (fy + fh > yMax - 0.1) break;
          sl.addText(k, { x: px + 0.3, y: fy, w: panelW - 0.6, h: 0.26, fontFace: FONT, fontSize: 11, color: C.grey, valign: "top", margin: 0 });
          sl.addText(v, { x: px + 0.3, y: fy + 0.26, w: panelW - 0.6, h: fh - 0.3, fontFace: FONT, fontSize: size, color: C.ink, bold: true, valign: "top", margin: 0 });
          fy += fh;
        }
      });
    }

    // 3) Finansal riskler, 4) Genel proje riskleri
    riskSlides("Finansal Riskler", d.fin, "Dokümanlarda belirgin bir finansal risk tespit edilmedi.");
    riskSlides("Genel Proje Riskleri", d.prj, "Dokümanlarda belirgin bir proje riski tespit edilmedi.");

    const safe = (x) => String(x || "ihale").normalize("NFKD").replace(/[ıİ]/g, "i").replace(/[şŞ]/g, "s").replace(/[ğĞ]/g, "g").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 50);
    const name = `BidNoBid_${t.ikn ? safe(t.ikn.replace("/", "-")) + "_" : ""}${safe(d.title)}_${now.toISOString().slice(0, 10)}.pptx`;
    return { pptx, name };
  }

  async function download(input) {
    const { pptx, name } = await build(input);
    await pptx.writeFile({ fileName: name });
    return name;
  }
  async function toBlob(input) {
    const { pptx, name } = await build(input);
    return { blob: await pptx.write({ outputType: "blob" }), name };
  }

  window.TR_SUNUM = { build, download, toBlob, collect };
})();
