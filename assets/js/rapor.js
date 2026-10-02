/*
 * Tender Radar — İhale Özet Raporu (Word .docx)
 * Proje özeti sayfasındaki kural tabanlı ve yapay zekâ özetlerinden, tarayıcıda profesyonel bir Word raporu üretir.
 * docx kütüphanesi ilk kullanımda yüklenir; dosya sunucuya gönderilmez, doğrudan indirilir.
 */
(function () {
  "use strict";

  const DOCX_URL = "https://cdn.jsdelivr.net/npm/docx@9.8.1/+esm";
  const AUTHOR = "Muhammet Emin Gülay";
  const C = { navy: "0F172A", accent: "0E7490", accentSoft: "E0F2F6", grey: "64748B", line: "CBD5E1", zebra: "F8FAFC", warn: "B45309", warnSoft: "FDF3E2", text: "1E293B" };
  const FONT = "Calibri";
  const PAGE_W = 11906, MARGIN = 1134, CONTENT_W = PAGE_W - 2 * MARGIN;   // A4, 2 cm kenar boşluğu
  const TYPE_SHORT = { idari: "İdari Ş.", teknik: "Teknik Ş.", cetvel: "Cetvel", sozlesme: "Sözleşme", ilan: "İlan", zeyil: "Zeyilname", form: "Form", diger: "Doküman" };
  const STATUS = { takip: "Takipte", hazirlik: "Teklif hazırlanıyor", verildi: "Teklif verildi", kapandi: "Sonuçlandı / Pas" };

  let lib = null;
  async function load() { return lib || (lib = await import(DOCX_URL)); }

  const fmtDate = (d, time) => (d ? new Date(d).toLocaleString("tr-TR", time ? { dateStyle: "long", timeStyle: "short" } : { dateStyle: "long" }) : "");
  const srcText = (src) => (src ? `${TYPE_SHORT[src.type] || "Doküman"}${src.page ? " s." + src.page : ""}` : "");
  const qty = (n) => (isFinite(n) ? Number(n).toLocaleString("tr-TR", { maximumFractionDigits: 3 }) : String(n || ""));
  const safeFile = (s) => String(s || "ihale").normalize("NFKD").replace(/[ıİ]/g, "i").replace(/[şŞ]/g, "s").replace(/[ğĞ]/g, "g").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 60);

  async function build({ tender: t, rec, watch }) {
    const D = await load();
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, AlignmentType,
      Header, Footer, PageNumber, TabStopType, HeadingLevel, LevelFormat, VerticalAlign, TableLayoutType } = D;
    const s = rec.summary || { fields: {}, items: [], tech: { kw: [], standards: [], brands: [], requirements: [], heads: [] }, flags: [] };
    const f = s.fields || {}, tech = s.tech || {}, ai = rec.ai || null;
    const now = new Date();

    // ---- Yardımcılar
    const run = (text, o = {}) => new TextRun({ text: String(text ?? ""), font: FONT, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color || C.text, ...o.extra });
    const para = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { before: o.before ?? 0, after: o.after ?? 100, line: o.line ?? 276 },
      alignment: o.align, keepNext: o.keepNext, border: o.border, shading: o.shading, indent: o.indent });
    const text = (t2, o = {}) => para(run(t2, o), o);
    const withSrc = (value, src) => [run(value), ...(src ? [run("  (" + srcText(src) + ")", { size: 16, color: C.grey })] : [])];
    const H1 = (no, title) => new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, spacing: { before: 320, after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: C.accent, space: 4 } },
      children: [new TextRun({ text: `${no}. `, color: C.accent, bold: true, font: FONT, size: 26 }), new TextRun({ text: title.toLocaleUpperCase("tr-TR"), bold: true, font: FONT, size: 26, color: C.navy })] });
    const H2 = (title) => new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 200, after: 80 }, children: [new TextRun({ text: title, bold: true, font: FONT, size: 22, color: C.accent })] });
    const bullets = (arr, o = {}) => (arr || []).filter(Boolean).map((x) => new Paragraph({ numbering: { reference: o.ref || "dot", level: 0 }, spacing: { after: 60, line: 264 },
      children: Array.isArray(x) ? x : [run(x)] }));
    const none = (msg) => text(msg, { italics: true, color: C.grey });
    const border = (color = C.line, size = 4) => ({ style: BorderStyle.SINGLE, size, color });
    const cellBorders = { top: border(), bottom: border(), left: border(), right: border() };
    const cell = (children, width, o = {}) => new TableCell({
      width: { size: width, type: WidthType.DXA }, verticalAlign: o.valign || VerticalAlign.CENTER, columnSpan: o.span,
      shading: o.fill ? { type: ShadingType.CLEAR, color: "auto", fill: o.fill } : undefined,
      margins: { top: 70, bottom: 70, left: 110, right: 110 }, borders: o.borders || cellBorders,
      children: (Array.isArray(children) ? children : [children]).map((c) => (c instanceof Paragraph ? c : para(c, { after: 0 })))
    });
    const table = (widths, rows) => new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows });
    // Etiket / değer tablosu (zebra)
    const kvTable = (pairs) => {
      const rows = pairs.filter((p) => p && p[1]).map(([label, value, src], i) => new TableRow({ cantSplit: true, children: [
        cell(run(label, { bold: true, color: C.navy, size: 20 }), 2900, { fill: C.accentSoft }),
        cell(withSrc(value, src), CONTENT_W - 2900, { fill: i % 2 ? C.zebra : undefined })
      ] }));
      return rows.length ? [table([2900, CONTENT_W - 2900], rows), text("", { after: 60 })] : [none("Bu bölüm için dokümanlarda bilgi bulunamadı.")];
    };

    const title = f.isAdi?.v || t.title || "İhale";
    const idare = f.idare?.v || t.authority || "";
    const tDate = t.tenderDate ? new Date(t.tenderDate) : null;
    const daysLeft = tDate ? Math.ceil((tDate - now) / 864e5) : null;
    const children = [];

    // ---- Kapak bloğu
    children.push(
      para(run("İHALE ÖZET RAPORU", { bold: true, color: C.accent, size: 20, extra: { characterSpacing: 40 } }), { after: 60 }),
      para(run(title, { bold: true, size: 36, color: C.navy }), { after: 80, line: 300 }),
      para(run(idare, { size: 24, color: C.grey }), { after: 240,
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.accent, space: 8 } } })
    );
    // Özet şeridi: 4 sütunlu bilgi kutuları
    const tile = (label, value) => cell([para(run(label.toLocaleUpperCase("tr-TR"), { size: 15, bold: true, color: C.grey }), { after: 20 }), para(run(value || "—", { size: 21, bold: true, color: C.navy }), { after: 0 })],
      CONTENT_W / 4, { fill: C.zebra, borders: { top: border(C.accent, 12), bottom: border(C.line), left: border("FFFFFF"), right: border("FFFFFF") } });
    children.push(table([CONTENT_W / 4, CONTENT_W / 4, CONTENT_W / 4, CONTENT_W / 4], [
      new TableRow({ children: [
        tile("İhale tarihi", f.tarih?.v || (tDate ? fmtDate(tDate, true) : "")),
        tile("Kalan süre", daysLeft == null ? "" : daysLeft < 0 ? "Tarihi geçti" : daysLeft === 0 ? "Bugün" : `${daysLeft} gün`),
        tile("İKN / Referans", t.ikn || t.refNo || ""),
        tile("İl", t.city || "")
      ] }),
      new TableRow({ children: [
        tile("Tür", f.tur?.v || ""),
        tile("Usul", f.usul?.v || t.procedure || ""),
        tile("Teklif şekli", f.eteklif ? "e-teklif (EKAP)" : ""),
        tile("Takip durumu", watch ? STATUS[watch.status] || watch.status || "Takipte" : "Takipte değil")
      ] })
    ]));
    children.push(text("", { after: 120 }));
    children.push(table([2200, CONTENT_W - 2200], [
      ["Hazırlayan", AUTHOR], ["Rapor tarihi", fmtDate(now, true)],
      ["İncelenen doküman", `${(rec.files || []).length} dosya`],
      ["Analiz yöntemi", ai ? `Kural tabanlı doküman analizi + yapay zekâ özeti (${ai.model || ai.provider || ""})` : "Kural tabanlı doküman analizi"]
    ].map(([a, b]) => new TableRow({ children: [cell(run(a, { size: 18, color: C.grey }), 2200, { borders: { top: border("FFFFFF"), bottom: border(C.line), left: border("FFFFFF"), right: border("FFFFFF") } }),
      cell(run(b, { size: 18, bold: true }), CONTENT_W - 2200, { borders: { top: border("FFFFFF"), bottom: border(C.line), left: border("FFFFFF"), right: border("FFFFFF") } })] }))));

    // ---- 1. Yönetici özeti
    let n = 0;
    children.push(H1(++n, "Yönetici Özeti"));
    const lead = ai?.genel_ozet || s.genel || "";
    children.push(para(run(lead || "Özet bulunmuyor.", { size: 22 }), { after: 120, line: 300, shading: { type: ShadingType.CLEAR, color: "auto", fill: C.accentSoft },
      border: { left: { style: BorderStyle.SINGLE, size: 24, color: C.accent, space: 8 } }, indent: { left: 120, right: 120 } }));
    if (ai && s.genel) { children.push(H2("Doküman verilerinden otomatik özet")); children.push(text(s.genel, { size: 20, color: C.grey, line: 288 })); }

    // ---- 2. Künye
    children.push(H1(++n, "İhale Künyesi"));
    children.push(...kvTable([
      ["İdare", idare, f.idare?.src], ["İşin adı", title, f.isAdi?.src], ["İdare adresi", f.adres?.v, f.adres?.src],
      ["İhale türü", f.tur?.v, f.tur?.src], ["İhale usulü", f.usul?.v, f.usul?.src],
      ["İhale tarihi / saati", f.tarih?.v || (tDate ? fmtDate(tDate, true) + " (ilandan)" : ""), f.tarih?.src],
      ["Teklif şekli", f.eteklif?.v, f.eteklif?.src], ["Teklif verilecek yer", f.toplanti?.v, f.toplanti?.src],
      ["Teslim / iş yeri", f.yer?.v || t.city, f.yer?.src], ["Süre", (f.sure || f.teslimSure)?.v, (f.sure || f.teslimSure)?.src],
      ["Sözleşme türü", f.sozTuru?.v, f.sozTuru?.src], ["Kısmi teklif", f.kismi?.v, f.kismi?.src],
      ["Miktar ve tür", f.miktar?.v, f.miktar?.src], ["İKN", t.ikn], ["EKAP bağlantısı", t.ekapUrl], ["İlan bağlantısı", t.ilanUrl]
    ]));
    if (ai && ai.kunye) {
      const k = ai.kunye, labels = { idare: "İdare", isin_adi: "İşin adı", ihale_turu_usulu: "Tür / usul", ihale_tarihi: "İhale tarihi", yer: "Yer", sure: "Süre", sozlesme_turu: "Sözleşme türü", kalem_sayisi: "Kalemler" };
      const pairs = Object.entries(labels).map(([key, l]) => [l, k[key]]).filter((p) => p[1] && !/^belirtilmemiş$/i.test(p[1]));
      if (pairs.length) { children.push(H2("Yapay zekâ değerlendirmesine göre künye")); children.push(...kvTable(pairs)); }
    }

    // ---- 3. Kapsam
    children.push(H1(++n, "İşin Kapsamı"));
    if (ai && ai.kapsam?.length) children.push(...bullets(ai.kapsam));
    if (tech.scope) { children.push(H2("Teknik şartnameye göre kapsam")); children.push(para([run(tech.scope.v, { size: 20 }), run("  (" + srcText(tech.scope.src) + ")", { size: 16, color: C.grey })], { line: 288 })); }
    if (!(ai && ai.kapsam?.length) && !tech.scope) children.push(none(f.miktar ? "Ayrıntılı kapsam bulunamadı; idari şartnamedeki miktar ve tür bilgisi künyede yer alıyor." : "Kapsam bilgisi dokümanlarda bulunamadı."));
    if (tech.heads?.length) { children.push(H2("Teknik şartname bölümleri")); children.push(text(tech.heads.join("  ·  "), { size: 18, color: C.grey })); }

    // ---- 4. Kalem listesi
    children.push(H1(++n, "Kalem Listesi"));
    const items = (s.items && s.items.length) ? s.items.map((i) => [i.no, i.name, qty(i.qty), i.unit])
      : (ai?.ana_kalemler || []).map((i, k) => [String(k + 1), i.ad, i.miktar, i.birim]);
    if (items.length) {
      const W = [700, CONTENT_W - 700 - 1500 - 1300, 1500, 1300];
      const hd = (x, w, al) => cell(para(run(x, { bold: true, color: "FFFFFF", size: 19 }), { after: 0, align: al }), w, { fill: C.navy });
      children.push(text(`${items.length} kalem${s.items?.length ? "" : " (yapay zekâ özetinden — öne çıkan kalemler)"}`, { size: 18, color: C.grey, after: 60 }));
      children.push(table(W, [
        new TableRow({ tableHeader: true, children: [hd("No", W[0]), hd("Kalem", W[1]), hd("Miktar", W[2], AlignmentType.RIGHT), hd("Birim", W[3])] }),
        ...items.map((r, i) => new TableRow({ cantSplit: true, children: [
          cell(run(r[0], { size: 19 }), W[0], { fill: i % 2 ? C.zebra : undefined }),
          cell(run(r[1], { size: 19 }), W[1], { fill: i % 2 ? C.zebra : undefined }),
          cell(para(run(r[2], { size: 19 }), { after: 0, align: AlignmentType.RIGHT }), W[2], { fill: i % 2 ? C.zebra : undefined }),
          cell(run(r[3], { size: 19 }), W[3], { fill: i % 2 ? C.zebra : undefined })
        ] }))
      ]));
    } else children.push(none(f.kalemIlan ? `İdari şartnameye göre ${f.kalemIlan.v} kalem; birim fiyat cetveli yüklenmedi.` : "Birim fiyat teklif cetveli / mal listesi yüklenmedi."));
    if (tech.quantities?.length) { children.push(H2("Teknik metinde geçen miktarlar")); children.push(...bullets(tech.quantities.map((q) => `${q.qty} × ${q.name}`))); }

    // ---- 5. Teknik gereksinimler
    children.push(H1(++n, "Teknik Gereksinimler"));
    if (ai && ai.teknik_gereksinimler?.length) children.push(...bullets(ai.teknik_gereksinimler));
    children.push(...kvTable([
      ["Öne çıkan konular", (tech.kw || []).slice(0, 12).map((x) => `${x.k} (${x.n})`).join(", ")],
      ["Standartlar", (tech.standards || []).map((x) => x.k).join(", ")],
      ["Markalar", (tech.brands || []).length ? tech.brands.map((x) => x.k).join(", ") + (tech.muadil ? ` — "muadil/eşdeğer" ifadesi ${tech.muadil} yerde geçiyor` : ' — "muadil" ifadesi bulunamadı') : ""],
      ["Garanti", f.garanti?.v, f.garanti?.src], ["Eğitim", f.egitim?.v, f.egitim?.src],
      ["Testler", f.fat || f.sat ? [f.fat && "Fabrika kabul testi (FAT)", f.sat && "Saha kabul testi (SAT)"].filter(Boolean).join(", ") : "", (f.fat || f.sat)?.src],
      ["Yedek parça", f.yedek?.v, f.yedek?.src]
    ]));
    if (tech.requirements?.length) { children.push(H2("Şartnameden öne çıkan zorunlu gereksinimler")); children.push(...bullets(tech.requirements.slice(0, 8).map((r) => [run(r.v, { size: 19 }), run("  (" + srcText(r.src) + ")", { size: 16, color: C.grey })]))); }

    // ---- 6. Yeterlik ve mali şartlar
    children.push(H1(++n, "Yeterlik ve Mali Şartlar"));
    children.push(...kvTable([
      ["İş deneyimi", f.deneyim?.v, f.deneyim?.src], ["Benzer iş", f.benzerIs?.v, f.benzerIs?.src], ["Geçici teminat", f.gecici?.v, f.gecici?.src],
      ["Kesin teminat", f.kesin?.v, f.kesin?.src], ["Fiyat farkı", f.fiyatFarki?.v, f.fiyatFarki?.src], ["Avans", f.avans?.v, f.avans?.src],
      ["Yerli istekli avantajı", f.yerli?.v, f.yerli?.src], ["Sınır değer katsayısı (N)", f.sinir?.v, f.sinir?.src],
      ["Teklif geçerlilik süresi", f.gecerlilik?.v, f.gecerlilik?.src], ["Gecikme cezası", f.ceza?.v, f.ceza?.src], ["Alt yüklenici", f.altYuk?.v, f.altYuk?.src]
    ]));
    if (ai && ai.yeterlik_ve_mali_sartlar?.length) { children.push(H2("Yapay zekâ değerlendirmesi")); children.push(...bullets(ai.yeterlik_ve_mali_sartlar)); }

    // ---- 7. Riskler ve dikkat edilecekler
    children.push(H1(++n, "Riskler ve Dikkat Edilecekler"));
    const flags = (s.flags || []).map((x) => [run(x.level === "warn" ? "Uyarı: " : "Bilgi: ", { bold: true, color: x.level === "warn" ? C.warn : C.accent }), run(x.text)]);
    if (flags.length) children.push(...bullets(flags));
    if (ai && ai.riskler?.length) { children.push(H2("Yapay zekâ risk değerlendirmesi")); children.push(...bullets(ai.riskler)); }
    if (!flags.length && !(ai && ai.riskler?.length)) children.push(none("Belirgin bir risk tespit edilmedi."));

    // ---- 8. Açıklama talebi soruları
    if (ai && ai.sorulacak_sorular?.length) {
      children.push(H1(++n, "İdareye Açıklama Talebi İçin Sorular"));
      const aGun = f.aciklamaGun?.v || 10;
      if (tDate && daysLeft > 0) children.push(text(`Açıklama talebi için son gün yaklaşık ${new Date(tDate - aGun * 864e5).toLocaleDateString("tr-TR")} (ihale tarihinden ${aGun} gün önce).`, { size: 19, color: C.grey }));
      children.push(...(ai.sorulacak_sorular || []).map((q, i) => new Paragraph({ numbering: { reference: "num", level: 0 }, spacing: { after: 80 }, children: [run(q)] })));
    }
    // ---- 9. Eksik / belirsiz
    const missing = [...(ai?.eksik_veya_belirsiz || []), ...((s.missing || []).length ? [`Yüklenmeyen doküman türleri: ${s.missing.map((m) => ({ idari: "İdari şartname", teknik: "Teknik şartname", cetvel: "Birim fiyat cetveli", sozlesme: "Sözleşme tasarısı" }[m] || m)).join(", ")}`] : [])];
    if (missing.length) { children.push(H1(++n, "Eksik veya Belirsiz Bilgiler")); children.push(...bullets(missing)); }

    // ---- 10. Değerlendirme ve karar
    children.push(H1(++n, "Değerlendirme ve Karar"));
    children.push(para([run("Teklif kararı:   ", { bold: true }), run("☐ Teklif verilecek      ☐ Teklif verilmeyecek      ☐ Ek inceleme gerekli", { size: 21 })], { after: 160 }));
    if (watch && watch.note) { children.push(H2("Notlarım")); watch.note.split(/\r?\n/).filter(Boolean).forEach((l) => children.push(text(l))); }
    children.push(H2("Değerlendirme notu"));
    // Elle yazmak için çizgili satırlar (ardışık paragraf kenarlıkları Word'de birleştiği için tablo satırı olarak)
    const blank = { top: border("FFFFFF"), left: border("FFFFFF"), right: border("FFFFFF"), bottom: border(C.line) };
    children.push(table([CONTENT_W], Array.from({ length: 4 }, () => new TableRow({ height: { value: 460, rule: "atLeast" }, children: [cell(run(" "), CONTENT_W, { borders: blank })] }))));
    children.push(text("", { after: 200 }));
    children.push(table([CONTENT_W / 2, CONTENT_W / 2], [new TableRow({ children: [
      cell([para(run("Hazırlayan", { size: 17, color: C.grey }), { after: 20 }), para(run(AUTHOR, { bold: true }), { after: 20 }), para(run(fmtDate(now), { size: 18, color: C.grey }), { after: 300 }), para(run("İmza", { size: 17, color: C.grey }), { after: 0 })],
        CONTENT_W / 2, { borders: { top: border(C.navy, 8), bottom: border("FFFFFF"), left: border("FFFFFF"), right: border("FFFFFF") }, valign: VerticalAlign.TOP }),
      cell([para(run("Onaylayan", { size: 17, color: C.grey }), { after: 20 }), para(run(" "), { after: 20 }), para(run("Tarih:", { size: 18, color: C.grey }), { after: 300 }), para(run("İmza", { size: 17, color: C.grey }), { after: 0 })],
        CONTENT_W / 2, { borders: { top: border(C.navy, 8), bottom: border("FFFFFF"), left: border("FFFFFF"), right: border("FFFFFF") }, valign: VerticalAlign.TOP })
    ] })]));

    // ---- Ek: incelenen dokümanlar
    children.push(H1("Ek", "İncelenen Dokümanlar"));
    const docs = rec.files || [];
    if (docs.length) {
      const W = [CONTENT_W - 2600 - 1100 - 1300, 2600, 1100, 1300];
      const hd = (x, w) => cell(run(x, { bold: true, color: "FFFFFF", size: 18 }), w, { fill: C.navy });
      children.push(table(W, [
        new TableRow({ tableHeader: true, children: [hd("Dosya", W[0]), hd("Tür", W[1]), hd("Sayfa", W[2]), hd("Durum", W[3])] }),
        ...docs.map((d, i) => new TableRow({ cantSplit: true, children: [
          cell(run(d.name, { size: 18 }), W[0], { fill: i % 2 ? C.zebra : undefined }),
          cell(run({ idari: "İdari şartname", teknik: "Teknik şartname", cetvel: "Birim fiyat / kalem listesi", sozlesme: "Sözleşme tasarısı", ilan: "İhale ilanı", zeyil: "Zeyilname", form: "Standart form", diger: "Diğer" }[d.type] || d.type, { size: 18 }), W[1], { fill: i % 2 ? C.zebra : undefined }),
          cell(run(d.pages || "—", { size: 18 }), W[2], { fill: i % 2 ? C.zebra : undefined }),
          cell(run(d.error ? "Okunamadı" : d.scanned ? "Taranmış" : "Okundu", { size: 18, color: d.error ? C.warn : C.text }), W[3], { fill: i % 2 ? C.zebra : undefined })
        ] }))
      ]));
    }
    children.push(text("", { after: 120 }));
    children.push(text("Bu rapor, ihale dokümanlarından otomatik çıkarım ile hazırlanmıştır" + (ai ? " ve yapay zekâ değerlendirmesi içerir" : "") +
      ". Parantez içindeki kaynak etiketleri bilginin alındığı dokümanı ve sayfayı gösterir. Teklif kararı ve fiyatlandırma öncesinde kritik bilgiler ihale dokümanlarının aslından teyit edilmelidir.", { size: 16, color: C.grey, italics: true, line: 252 }));

    // ---- Üst / alt bilgi
    const header = new Header({ children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.accent, space: 4 } }, spacing: { after: 0 },
      children: [new TextRun({ text: "TENDER RADAR", bold: true, font: FONT, size: 16, color: C.accent }), new TextRun({ text: "  ·  İhale Özet Raporu", font: FONT, size: 16, color: C.grey }),
        new TextRun({ text: `\t${t.ikn ? "İKN " + t.ikn : (title.length > 60 ? title.slice(0, 60) + "…" : title)}`, font: FONT, size: 16, color: C.grey })]
    })] });
    const footer = new Footer({ children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 4 } },
      children: [new TextRun({ text: `Hazırlayan: ${AUTHOR}  ·  ${fmtDate(now)}`, font: FONT, size: 16, color: C.grey }),
        new TextRun({ children: ["\tSayfa ", PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: C.grey })]
    })] });

    const doc = new Document({
      creator: AUTHOR, lastModifiedBy: AUTHOR, title: `İhale Özet Raporu — ${title}`, subject: idare, description: "Tender Radar ile hazırlanmıştır",
      styles: { default: { document: { run: { font: FONT, size: 21, color: C.text } } } },
      numbering: { config: [
        { reference: "dot", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 260 } }, run: { color: C.accent } } }] },
        { reference: "num", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 440, hanging: 300 } }, run: { color: C.accent, bold: true } } }] }
      ] },
      sections: [{ properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: 1134, bottom: 1134, left: MARGIN, right: MARGIN, header: 567, footer: 567 } } },
        headers: { default: header }, footers: { default: footer }, children }]
    });
    const blob = await Packer.toBlob(doc);
    const name = `Ihale_Ozet_Raporu_${safeFile(t.ikn ? t.ikn.replace("/", "-") : "")}${t.ikn ? "_" : ""}${safeFile(title)}_${now.toISOString().slice(0, 10)}.docx`;
    return { blob, name };
  }

  async function download(input) {
    const { blob, name } = await build(input);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return name;
  }

  window.TR_RAPOR = { build, download };
})();
