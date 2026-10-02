/*
 * Bid / No-Bid sunumu (PowerPoint .pptx)
 * Proje özetinden yönetici sunumu üretir: ihale adı ve tarihi, işin genel kapsamı, finansal riskler, genel proje riskleri.
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
  const fold = (s) => String(s || "").toLocaleLowerCase("tr-TR").replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" }[c]));
  const useful = (v) => v != null && String(v).trim() !== "" && !/^(belirtilmemiş|bilinmiyor|yok|-|—)\.?$/i.test(String(v).trim());
  // Sunum için: atıfları çıkar, araç dilini at, kısalt (kelime sınırında)
  function short(s, n = 150) {
    let t = String(s || "").replace(RX_CITE, "").replace(/[^.]*yapay zekâ[^.]*\.?/gi, "").replace(/\s+/g, " ").trim().replace(/\s+([.,;:])/g, "$1");
    if (t.length > n) { const i = t.lastIndexOf(" ", n); t = t.slice(0, i > n * 0.6 ? i : n).replace(/[,;:\s]+$/, "") + "…"; }
    return t;
  }
  const fmtDate = (d, time) => (d ? new Date(d).toLocaleString("tr-TR", time ? { dateStyle: "long", timeStyle: "short" } : { dateStyle: "long" }) : "");

  // ---- Risk sınıflandırma
  // Finansal: para akışını doğrudan etkileyen ifadeler ("birim fiyat cetveli" gibi doküman adları sayılmaz)
  const FIN_WORDS = /teminat|fiyat fark|avans|ceza|ödeme|hakediş|\bkur\b|döviz|maliyet|finans|nakit|sigorta|vergi|damga|kdv|kâr\b|zarar|nakde|bütçe|fiyat artış|enflasyon/i;
  const DOC_ISSUE = /çelişk|uyumsuz|uyuşma|tutarsız|zıt|farklı ihale|alakasız|belirsiz|okunama|eksik doküman/i;
  const FIN_RX = { test: (s) => { const v = String(s).replace(/birim fiyat (teklif )?cetvel\w*|teklif cetvel\w*/gi, ""); return !DOC_ISSUE.test(v) && FIN_WORDS.test(v); } };
  const FIN_LABEL = [[/teminat/i, "Teminat"], [/fiyat fark|\bkur\b|döviz/i, "Fiyat / kur riski"], [/avans|nakit|hakediş|ödeme|finans/i, "Nakit akışı"],
    [/ceza/i, "Ceza"], [/sigorta|vergi|damga|kdv/i, "Ek maliyet"], [/götürü|metraj|miktar/i, "Miktar riski"], [/.*/, "Finansal"]];
  const PRJ_LABEL = [[/çelişk|uyumsuz|uyuşma|tutarsız|zıt|farklı ihale|alakasız|belirsiz|okunama|eksik doküman/i, "Doküman"], [/süre|takvim|gün\b|teslim tarihi|termin/i, "Süre"], [/marka|muadil|rekabet/i, "Rekabet"], [/deneyim|benzer iş|yeterlik|referans/i, "Yeterlik"],
    [/çelişk|belirsiz|eksik|okunama|doküman|uyumsuz/i, "Doküman"], [/alt yüklenici|sözleşme|yükümlülük|sorumluluk|garanti/i, "Sözleşme"],
    [/teknik|protokol|entegrasyon|uyumlu|scada|plc|rtu|yazılım|donanım|test|kabul/i, "Teknik"], [/.*/, "Proje"]];
  const labelOf = (txt, table) => table.find(([rx]) => rx.test(txt))[1];

  function collect(t, rec) {
    const s = rec.summary || {}, f = s.fields || {}, tech = s.tech || {}, ai = rec.ai || {};
    const fin = [], prj = [];
    const seen = new Set();
    const push = (list, label, text) => {
      const v = short(text); if (!useful(v)) return;
      const k = fold(v).replace(/[^a-z0-9]/g, "").slice(0, 40);
      if (seen.has(k)) return; seen.add(k);
      list.push({ label, text: v });
    };
    // Doküman verisinden somut finansal riskler
    if (f.gecici || f.kesin) push(fin, "Teminat", [f.gecici && `Geçici teminat ${f.gecici.v}`, f.kesin && `kesin teminat ${f.kesin.v}`].filter(Boolean).join(", ") + "; teklif ve sözleşme aşamasında banka teminat limiti gerekir.");
    if (f.fiyatFarki?.v === "Verilmeyecek") push(fin, "Fiyat / kur riski", "Fiyat farkı verilmeyecek; kur ve malzeme fiyat artışları yükleniciye ait.");
    if (f.avans?.v === "Verilmeyecek") push(fin, "Nakit akışı", "Avans verilmeyecek; tedarik ve imalat dönemi öz kaynakla finanse edilecek.");
    if (f.ceza) push(fin, "Ceza", `Gecikme cezası: gecikilen her gün için ${f.ceza.v}.`);
    if (/götürü/i.test(f.sozTuru?.v || "")) push(fin, "Miktar riski", `${f.sozTuru.v} sözleşme; miktar ve metraj farkları yükleniciye ait.`);
    // Doküman verisinden genel proje riskleri
    const tDate = t.tenderDate ? new Date(t.tenderDate) : null;
    const days = tDate ? Math.ceil((tDate - Date.now()) / 864e5) : null;
    if (days != null && days >= 0 && days <= 10) push(prj, "Süre", `İhaleye ${days} gün kaldı; teklif hazırlık süresi kısa.`);
    const dp = f.deneyim ? parseFloat(String(f.deneyim.v).replace(/[^\d]/g, "")) : null;
    if (dp != null && dp >= 50) push(prj, "Yeterlik", `İş deneyim oranı yüksek (${f.deneyim.v}); referansların yeterliliği kontrol edilmeli.`);
    if ((tech.brands || []).length && !tech.muadil) push(prj, "Rekabet", `Şartnamede marka belirtilmiş (${tech.brands.slice(0, 3).map((b) => b.k).join(", ")}), muadil ifadesi bulunmuyor.`);
    if (f.altYuk && /(yaptırılamaz|verilemez|çalıştırılamaz|izin verilmemektedir)/.test(f.altYuk.v)) push(prj, "Sözleşme", "Alt yüklenici kullanımı kısıtlı; işin tamamı firma kaynaklarıyla yürütülmeli.");
    // Özet değerlendirmesindeki riskler (finansal / proje olarak ayrılır)
    // Dokümandan zaten somut olarak yazılan konular (ceza, fiyat farkı, avans, teminat oranı) özetten tekrar alınmaz
    const covered = (r) => (f.ceza && /ceza/i.test(r)) || (f.fiyatFarki && /fiyat fark/i.test(r)) || (f.avans && /avans/i.test(r)) ||
      ((f.gecici || f.kesin) && /(geçici|kesin) teminat[^.]*%/i.test(r));
    for (const r of ai.riskler || []) { if (FIN_RX.test(r)) { if (!covered(r)) push(fin, labelOf(r, FIN_LABEL), r); } else push(prj, labelOf(r, PRJ_LABEL), r); }
    for (const r of ai.yeterlik_ve_mali_sartlar || []) if (FIN_RX.test(r) && /ceza|avans|fiyat fark|ödeme|hakediş|sigorta/i.test(r) && !covered(r)) push(fin, labelOf(r, FIN_LABEL), r);
    if ((s.missing || []).length) push(prj, "Doküman", `İncelenmeyen doküman: ${s.missing.map((m) => ({ idari: "idari şartname", teknik: "teknik şartname", cetvel: "birim fiyat cetveli", sozlesme: "sözleşme tasarısı" }[m] || m)).join(", ")}.`);
    const unread = (ai.okunamayan_kisimlar || []).length + (ai.skipped || []).length || (s.unread || []).length;
    if (unread) push(prj, "Doküman", `${unread} doküman/bölüm okunamadı; ilgili kısımlar dokümanın aslından kontrol edilmeli.`);

    // Kapsam
    let scope = (ai.kapsam || []).filter(useful).map((x) => short(x, 160)).slice(0, 5);
    if (!scope.length && tech.scope) scope = tech.scope.v.split(/(?<=[.;])\s+/).filter((x) => x.length > 25).map((x) => short(x, 160)).slice(0, 4);
    if (!scope.length && f.miktar) scope = [short(f.miktar.v, 160)];
    const items = (s.items || []).length ? s.items : (ai.ana_kalemler || []).map((i) => ({ name: i.ad, qty: i.miktar, unit: i.birim }));
    const tidy = (window.TR_PROJE && window.TR_PROJE.core.tidyItemName) || ((x) => x);
    const topItems = items.slice(0, 3).map((i) => `${tidy(i.name)} (${typeof i.qty === "number" ? i.qty.toLocaleString("tr-TR") : i.qty} ${i.unit || ""})`.replace(/\s+\)/, ")"));
    if (topItems.length && scope.length < 5) scope.push(short(`Öne çıkan kalemler: ${topItems.join("; ")}`, 180));

    // Künye bilgileri
    const K = ai.kunye || {};
    const TUR_RX = [[/danışman/i, "Danışmanlık hizmeti"], [/yapım/i, "Yapım işi"], [/hizmet/i, "Hizmet alımı"], [/\bmal\b|mal alım|\balım/i, "Mal alımı"]];
    const turOf = (v) => { for (const [rx, l] of TUR_RX) if (rx.test(String(v || ""))) return l; return ""; };
    const tur = f.tur?.v || turOf(t.tur) || turOf((t.categories || []).find((c) => /alım|hizmet|yapım|danışman|\bmal\b/i.test(c))) || turOf(K.ihale_turu_usulu) || turOf(t.title);
    const facts = [
      ["İdare", f.idare?.v || t.authority],
      ["İş yeri", f.yer?.v || (useful(K.yer) ? K.yer : t.city)],
      ["Süre", (f.sure || f.teslimSure)?.v || (useful(K.sure) ? K.sure : "")],
      ["Kalem sayısı", (s.items || []).length ? `${s.items.length} kalem` : (useful(K.kalem_sayisi) ? K.kalem_sayisi : "")],
      ["Sözleşme türü", f.sozTuru?.v || (useful(K.sozlesme_turu) ? K.sozlesme_turu : "")],
      ["Teklif şekli", f.eteklif ? "e-teklif (EKAP)" : ""]
    ].filter(([, v]) => useful(v)).map(([k, v]) => [k, short(v, 70)]);

    return {
      title: f.isAdi?.v || (useful(K.isin_adi) ? K.isin_adi : "") || t.title || "İhale",
      idare: f.idare?.v || t.authority || "",
      tDate, days, tur, usul: f.usul?.v || t.procedure || "",
      dateText: f.tarih?.v || (tDate ? fmtDate(tDate, true) : ""),
      ref: t.ikn ? `İKN ${t.ikn}` : t.refNo || "",
      status: t.isCancelled ? "İptal edildi" : tDate ? (tDate > new Date() ? "Devam ediyor" : "İhale tarihi geçti") : "",
      scope, facts, fin: fin.slice(0, 6), prj: prj.slice(0, 6)
    };
  }

  async function build({ tender: t, rec }) {
    await load();
    const d = collect(t, rec);
    const pptx = new window.PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = AUTHOR; pptx.company = ""; pptx.title = `Bid / No-Bid — ${d.title}`;
    const now = new Date();
    const footerText = `Hazırlayan: ${AUTHOR}   |   ${fmtDate(now)}`;
    let pageNo = 0;

    // Ortak çerçeve: başlık, ince çizgi, alt bilgi
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
    // Etiketli risk satırları
    function riskRows(slide, list, y0, emptyMsg) {
      if (!list.length) { slide.addText(emptyMsg, { x: M, y: y0, w: W - 2 * M, h: 0.5, fontFace: FONT, fontSize: 16, color: C.grey, italic: true }); return; }
      const avail = H - 0.8 - y0, rowH = Math.min(0.82, avail / list.length);
      list.forEach((r, i) => {
        const y = y0 + i * rowH;
        slide.addShape(pptx.ShapeType.rect, { x: M, y: y + 0.12, w: 0.08, h: rowH - 0.24, fill: { color: C.navy }, line: { color: C.navy, width: 0 } });
        slide.addText(r.label, { x: M + 0.25, y, w: 2.6, h: rowH, fontFace: FONT, fontSize: 15, bold: true, color: C.navy, valign: "middle" });
        slide.addText(r.text, { x: M + 2.95, y, w: W - 2 * M - 2.95, h: rowH, fontFace: FONT, fontSize: 15, color: C.text, valign: "middle", fit: "shrink" });
        if (i < list.length - 1) slide.addShape(pptx.ShapeType.line, { x: M + 0.25, y: y + rowH, w: W - 2 * M - 0.25, h: 0, line: { color: C.line, width: 0.5 } });
      });
    }

    // 1) Kapak: ihale adı ve tarihi
    {
      const s1 = pptx.addSlide();
      pageNo++;
      s1.background = { color: C.white };
      s1.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.28, h: H, fill: { color: C.navy }, line: { color: C.navy, width: 0 } });
      s1.addText("BID / NO-BID DEĞERLENDİRMESİ", { x: 1.0, y: 1.05, w: 11, h: 0.4, fontFace: FONT, fontSize: 13, color: C.grey, bold: true, charSpacing: 3 });
      // Başlık alttan hizalı: kısa başlıklar idare adının hemen üstünde durur, uzunlar yukarı doğru büyür
      s1.addText(d.title, { x: 1.0, y: 1.45, w: 11.3, h: 1.6, fontFace: FONT, fontSize: 34, color: C.navy, bold: true, valign: "bottom", fit: "shrink" });
      s1.addText(d.idare, { x: 1.0, y: 3.1, w: 11.3, h: 0.7, fontFace: FONT, fontSize: 18, color: C.ink, valign: "top", fit: "shrink" });
      s1.addShape(pptx.ShapeType.line, { x: 1.0, y: 3.95, w: 11.3, h: 0, line: { color: C.navy, width: 1.5 } });
      const tiles = [["İHALE TARİHİ", d.dateText || "—"], ["KALAN SÜRE", d.days == null ? "—" : d.days < 0 ? "Tarihi geçti" : d.days === 0 ? "Bugün" : `${d.days} gün`],
        ["İHALE TÜRÜ / USUL", [d.tur, d.usul].filter(Boolean).join(" · ") || "—"], ["DURUM", d.status || "—"]];
      const tw = 11.3 / 4;
      tiles.forEach(([k, v], i) => {
        s1.addText(k, { x: 1.0 + i * tw, y: 4.2, w: tw - 0.2, h: 0.35, fontFace: FONT, fontSize: 11, color: C.grey, bold: true, charSpacing: 1 });
        s1.addText(v, { x: 1.0 + i * tw, y: 4.55, w: tw - 0.2, h: 0.7, fontFace: FONT, fontSize: 18, color: C.ink, bold: true, valign: "top", fit: "shrink" });
      });
      if (d.ref) s1.addText(d.ref, { x: 1.0, y: 5.5, w: 6, h: 0.35, fontFace: FONT, fontSize: 12, color: C.grey });
      s1.addText(`Hazırlayan: ${AUTHOR}`, { x: 1.0, y: H - 1.05, w: 7, h: 0.35, fontFace: FONT, fontSize: 13, color: C.ink, bold: true });
      s1.addText(fmtDate(now), { x: 1.0, y: H - 0.72, w: 7, h: 0.3, fontFace: FONT, fontSize: 12, color: C.grey });
    }

    // 2) İşin genel kapsamı
    {
      const s2 = pptx.addSlide();
      frame(s2, "İşin Genel Kapsamı", d.idare);
      const y0 = 1.95, panelW = 4.3, textW = W - 2 * M - panelW - 0.4;
      if (d.scope.length) {
        s2.addText(d.scope.map((x) => ({ text: x, options: { bullet: { code: "25AA" }, paraSpaceAfter: 10 } })),
          { x: M, y: y0, w: textW, h: H - 0.8 - y0, fontFace: FONT, fontSize: 16, color: C.text, valign: "top", fit: "shrink" });
      } else s2.addText("Kapsam bilgisi dokümanlarda bulunamadı.", { x: M, y: y0, w: textW, h: 0.5, fontFace: FONT, fontSize: 16, color: C.grey, italic: true });
      const px = W - M - panelW;
      s2.addShape(pptx.ShapeType.rect, { x: px, y: y0, w: panelW, h: H - 0.8 - y0, fill: { color: C.fill }, line: { color: C.fill, width: 0 } });
      s2.addText("TEMEL BİLGİLER", { x: px + 0.3, y: y0 + 0.2, w: panelW - 0.6, h: 0.35, fontFace: FONT, fontSize: 11, color: C.grey, bold: true, charSpacing: 1 });
      // Her bilgi kendi satır sayısına göre yer kaplar; sığmayan son bilgiler atlanır (üst üste binmez)
      let fy = y0 + 0.65;
      const fyMax = H - 0.95;
      for (const [k, v] of d.facts) {
        const lines = Math.min(3, Math.ceil(v.length / 42));
        const fh = 0.28 + lines * 0.26 + 0.08;
        if (fy + fh > fyMax) break;
        s2.addText(k, { x: px + 0.3, y: fy, w: panelW - 0.6, h: 0.26, fontFace: FONT, fontSize: 11, color: C.grey, valign: "top", margin: 0 });
        s2.addText(v, { x: px + 0.3, y: fy + 0.26, w: panelW - 0.6, h: lines * 0.26 + 0.05, fontFace: FONT, fontSize: 13, color: C.ink, bold: true, valign: "top", margin: 0, fit: "shrink" });
        fy += fh;
      }
    }

    // 3) Finansal riskler
    { const s3 = pptx.addSlide(); frame(s3, "Finansal Riskler"); riskRows(s3, d.fin, 1.65, "Dokümanlarda belirgin bir finansal risk tespit edilmedi."); }
    // 4) Genel proje riskleri
    { const s4 = pptx.addSlide(); frame(s4, "Genel Proje Riskleri"); riskRows(s4, d.prj, 1.65, "Dokümanlarda belirgin bir proje riski tespit edilmedi."); }

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
