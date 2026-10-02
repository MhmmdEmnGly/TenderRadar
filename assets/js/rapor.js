/*
 * İhale Özet Raporu (Word .docx)
 * Proje özeti sayfasındaki doküman analizinden tarayıcıda kurumsal bir Word raporu üretir.
 * docx kütüphanesi ilk kullanımda yüklenir; dosya sunucuya gönderilmez, doğrudan indirilir.
 */
(function () {
  "use strict";

  const DOCX_URL = "https://cdn.jsdelivr.net/npm/docx@9.8.1/+esm";
  const AUTHOR = "Muhammet Emin Gülay";
  // Sade kurumsal palet: lacivert vurgu, koyu gri metin, nötr gri çizgiler/zeminler
  const C = { navy: "1F3864", ink: "262626", text: "333333", grey: "6B6B6B", line: "BFBFBF", hair: "D9D9D9", fill: "F2F2F2", zebra: "FAFAFA", white: "FFFFFF", cite: "2F5496" };
  // Doküman atıfları: "(Özel Teknik Ş. md. 1.9)", "(İdari Şartname, s. 4)" vb.
  const RX_CITE = /\((?=[^()]{2,140}\))[^()]*?(?:Ş\.|[Şş]artname|[Ss]özleşme|[Cc]etvel|İlan|[Zz]eyilname|[Tt]asar|\bmd\.|[Mm]adde|\bs\.\s?\d|[Ss]ayfa|\bEk[- ]?\d|[Kk]alem\s?\d)[^()]*\)/g;
  const FONT = "Calibri";
  const PAGE_W = 11906, MARGIN = 1134, CONTENT_W = PAGE_W - 2 * MARGIN;   // A4, 2 cm kenar boşluğu
  const TYPE_SHORT = { idari: "İdari Şartname", teknik: "Teknik Şartname", cetvel: "Birim Fiyat Cetveli", sozlesme: "Sözleşme Tasarısı", ilan: "İhale İlanı", zeyil: "Zeyilname", form: "Standart Form", diger: "Doküman" };
  const TYPE_LONG = { idari: "İdari şartname", teknik: "Teknik şartname", cetvel: "Birim fiyat / kalem listesi", sozlesme: "Sözleşme tasarısı", ilan: "İhale ilanı", zeyil: "Zeyilname", form: "Standart form", diger: "Diğer" };
  const STATUS = { takip: "İnceleniyor", hazirlik: "Teklif hazırlanıyor", verildi: "Teklif verildi", kapandi: "Sonuçlandı" };

  let lib = null;
  async function load() { return lib || (lib = await import(DOCX_URL)); }

  const fmtDate = (d, time) => (d ? new Date(d).toLocaleString("tr-TR", time ? { dateStyle: "long", timeStyle: "short" } : { dateStyle: "long" }) : "");
  const srcText = (src) => (src ? `${TYPE_SHORT[src.type] || "Doküman"}${src.page ? ", s. " + src.page : ""}` : "");
  const qty = (n) => (isFinite(n) ? Number(n).toLocaleString("tr-TR", { maximumFractionDigits: 3 }) : String(n || ""));
  const safeFile = (s) => String(s || "ihale").normalize("NFKD").replace(/[ıİ]/g, "i").replace(/[şŞ]/g, "s").replace(/[ğĞ]/g, "g").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 60);
  const useful = (v) => v != null && String(v).trim() !== "" && !/^(belirtilmemiş|bilinmiyor|yok|-|—)\.?$/i.test(String(v).trim());
  // Rapora araç/otomasyon diline ait ifadeler girmesin
  const tidy = (s) => String(s || "").replace(/[^.]*yapay zekâ[^.]*\.?/gi, "").replace(/\s{2,}/g, " ").trim();

  async function build({ tender: t, rec, watch }) {
    const D = await load();
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, AlignmentType,
      Header, Footer, PageNumber, TabStopType, HeadingLevel, LevelFormat, VerticalAlign, TableLayoutType } = D;
    const s = rec.summary || { fields: {}, items: [], tech: {}, flags: [] };
    const f = s.fields || {}, tech = s.tech || {}, ai = rec.ai || {};
    const K = ai.kunye || {};
    const now = new Date();

    // ---- Yazı ve paragraf yardımcıları
    const run = (text, o = {}) => new TextRun({ text: String(text ?? ""), font: FONT, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color || C.text, allCaps: o.caps, characterSpacing: o.spacing });
    const para = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { before: o.before ?? 0, after: o.after ?? 100, line: o.line ?? 276 },
      alignment: o.align, keepNext: o.keepNext, keepLines: o.keepLines, border: o.border, indent: o.indent });
    const text = (t2, o = {}) => para(run(t2, o), o);
    const cite = (src) => (src ? [run(`  (${srcText(src)})`, { size: 17, color: C.cite })] : []);
    // Metin içindeki "(Teknik Ş. md. 4.2)" gibi atıfları ayrı renkte koşu olarak yaz
    const citeRuns = (str, o = {}) => {
      const s2 = String(str ?? ""), out = [];
      let last = 0;
      for (const m of s2.matchAll(RX_CITE)) {
        if (m.index > last) out.push(run(s2.slice(last, m.index), o));
        out.push(run(m[0], { ...o, size: (o.size || 21) - 2, color: C.cite }));
        last = m.index + m[0].length;
      }
      if (last < s2.length) out.push(run(s2.slice(last), o));
      return out.length ? out : [run("", o)];
    };
    const H1 = (no, title) => new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, spacing: { before: 360, after: 140 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.navy, space: 4 } },
      children: [run(no ? `${no}.  ` : "", { bold: true, size: 24, color: C.navy }), run(title, { bold: true, size: 24, color: C.navy, caps: true, spacing: 10 })] });
    const H2 = (title) => new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 200, after: 80 }, children: [run(title, { bold: true, size: 21, color: C.ink })] });
    const bullets = (arr, ref = "dot") => (arr || []).filter((x) => (Array.isArray(x) ? x.length : useful(x))).map((x) => new Paragraph({
      numbering: { reference: ref, level: 0 }, spacing: { after: 70, line: 268 }, children: Array.isArray(x) ? x : citeRuns(x) }));
    const none = (msg) => text(msg, { italics: true, color: C.grey, size: 20 });
    const B = (color = C.hair, size = 4) => ({ style: BorderStyle.SINGLE, size, color });
    const NONE = { style: BorderStyle.NONE, size: 0, color: C.white };
    const cell = (children, width, o = {}) => new TableCell({
      width: { size: width, type: WidthType.DXA }, verticalAlign: o.valign || VerticalAlign.CENTER, columnSpan: o.span,
      shading: o.fill ? { type: ShadingType.CLEAR, color: "auto", fill: o.fill } : undefined,
      margins: { top: o.pad ?? 80, bottom: o.pad ?? 80, left: 120, right: 120 },
      borders: o.borders || { top: B(), bottom: B(), left: B(), right: B() },
      children: (Array.isArray(children) ? children : [children]).map((c) => (c instanceof Paragraph ? c : para(c, { after: 0 })))
    });
    const table = (widths, rows) => new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, rows });
    // Etiket / değer tablosu: yalnızca yatay ince çizgiler, gri etiket sütunu
    const LBL = 2700;
    const kvTable = (pairs, emptyMsg) => {
      const rows = pairs.filter((p) => p && useful(p[1])).map(([label, value, src]) => new TableRow({ cantSplit: true, children: [
        cell(run(label, { bold: true, color: C.ink, size: 20 }), LBL, { fill: C.fill, borders: { top: B(), bottom: B(), left: NONE, right: NONE } }),
        cell([para([...citeRuns(value, { size: 20 }), ...cite(src)], { after: 0 })], CONTENT_W - LBL, { borders: { top: B(), bottom: B(), left: NONE, right: NONE } })
      ] }));
      return rows.length ? [table([LBL, CONTENT_W - LBL], rows), text("", { after: 40 })] : (emptyMsg ? [none(emptyMsg)] : []);
    };
    const headRow = (labels, widths, aligns = []) => new TableRow({ tableHeader: true, children: labels.map((l, i) =>
      cell(para(run(l, { bold: true, color: C.white, size: 18 }), { after: 0, align: aligns[i] }), widths[i], { fill: C.navy, borders: { top: B(C.navy), bottom: B(C.navy), left: B(C.navy), right: B(C.navy) } })) });
    const bodyCell = (content, w, i, align) => cell(para(Array.isArray(content) ? content : run(content, { size: 19 }), { after: 0, align }), w,
      { fill: i % 2 ? C.zebra : undefined, borders: { top: B(), bottom: B(), left: NONE, right: NONE } });

    // ---- Temel bilgiler (doküman verisi öncelikli, yoksa özet değerlendirmesi)
    const title = f.isAdi?.v || (useful(K.isin_adi) ? K.isin_adi : "") || t.title || "İhale";
    const idare = f.idare?.v || t.authority || "";
    const tDate = t.tenderDate ? new Date(t.tenderDate) : null;
    const daysLeft = tDate ? Math.ceil((tDate - now) / 864e5) : null;
    // İhale türü: idari şartname → bülten/ilan türü → ilan kategorileri → özet künyesi → iş adı (sırayla, ilk bulunan)
    const TUR_RX = [[/danışman/i, "Danışmanlık hizmeti"], [/yapım/i, "Yapım işi"], [/hizmet/i, "Hizmet alımı"], [/\bmal\b|mal alım|\balım/i, "Mal alımı"]];
    const turOf = (str) => { const v = String(str || ""); for (const [rx, label] of TUR_RX) if (rx.test(v)) return label; return ""; };
    const ihaleTuru = f.tur?.v || turOf(t.tur) || turOf((t.categories || []).find((c) => /alım|hizmet|yapım|danışman|\bmal\b/i.test(c)))
      || turOf(K.ihale_turu_usulu) || turOf(`${t.title || ""} ${f.isAdi?.v || ""}`);
    // Durum: iptal → İptal edildi; ihale saati gelmediyse → Devam ediyor; geçtiyse → İhale tarihi geçti
    const durum = t.isCancelled ? "İptal edildi" : !tDate ? (watch ? STATUS[watch.status] || "İnceleniyor" : "İnceleniyor") : tDate > now ? "Devam ediyor" : "İhale tarihi geçti";
    const reportNo = `İÖR-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${(t.ikn || t.refNo || t.id || "").replace(/\D/g, "").slice(-6) || "0001"}`;
    const children = [];

    // ---- Kapak bloğu
    children.push(
      para(run("İhale Özet Raporu", { bold: true, color: C.grey, size: 19, caps: true, spacing: 30 }), { after: 80 }),
      para(run(title, { bold: true, size: 34, color: C.navy }), { after: 80, line: 300 }),
      para(run(idare, { size: 23, color: C.ink }), { after: 260, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.navy, space: 10 } } })
    );
    const Q = CONTENT_W / 4;
    const tile = (label, value) => cell([para(run(label, { size: 15, bold: true, color: C.grey, caps: true, spacing: 10 }), { after: 30 }), para(run(useful(value) ? value : "—", { size: 21, bold: true, color: C.ink }), { after: 0 })],
      Q, { pad: 100, borders: { top: NONE, bottom: B(C.hair), left: NONE, right: NONE } });
    children.push(table([Q, Q, Q, Q], [
      new TableRow({ children: [
        tile("İhale tarihi", f.tarih?.v || (tDate ? fmtDate(tDate, true) : "")),
        tile("Kalan süre", daysLeft == null ? "" : daysLeft < 0 ? "Tarihi geçti" : daysLeft === 0 ? "Bugün" : `${daysLeft} gün`),
        tile("İKN / Referans", t.ikn || t.refNo || ""),
        tile("İl", t.city || "")
      ] }),
      new TableRow({ children: [
        tile("İhale türü", ihaleTuru),
        tile("Usul", f.usul?.v || t.procedure || ""),
        tile("Teklif şekli", f.eteklif ? "e-teklif (EKAP)" : ""),
        tile("Durum", durum)
      ] })
    ]));
    children.push(text("", { after: 160 }));
    const metaB = { top: NONE, bottom: B(C.hair), left: NONE, right: NONE };
    children.push(table([2200, CONTENT_W - 2200], [
      ["Hazırlayan", AUTHOR], ["Rapor tarihi", fmtDate(now)], ["Rapor no", reportNo], ["İncelenen doküman", `${(rec.files || []).length} adet`], ["Gizlilik", "Şirket içi"]
    ].map(([a, b]) => new TableRow({ children: [cell(run(a, { size: 18, color: C.grey }), 2200, { borders: metaB, pad: 50 }), cell(run(b, { size: 18, bold: true, color: C.ink }), CONTENT_W - 2200, { borders: metaB, pad: 50 })] }))));

    // ---- 1. Yönetici özeti
    let n = 0;
    children.push(H1(++n, "Yönetici Özeti"));
    const lead = tidy(ai.genel_ozet) || tidy(s.genel) || "";
    children.push(para(citeRuns(lead || "Özet için yeterli doküman bilgisi bulunmuyor.", { size: 22, color: C.ink }), { after: 120, line: 312,
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: C.navy, space: 12 } }, indent: { left: 240 } }));

    // ---- 2. Künye
    children.push(H1(++n, "İhale Künyesi"));
    const pick = (field, aiVal) => (field ? [field.v, field.src] : useful(aiVal) ? [aiVal, null] : [null, null]);
    const row = (label, field, aiVal) => { const [v, src] = pick(field, aiVal); return [label, v, src]; };
    children.push(...kvTable([
      row("İdare", f.idare, K.idare || t.authority), row("İşin adı", f.isAdi, K.isin_adi || t.title), row("İdare adresi", f.adres),
      row("İhale türü / usulü", f.tur && f.usul ? { v: `${f.tur.v}, ${f.usul.v}`, src: f.usul.src } : f.tur || (f.usul && ihaleTuru ? { v: `${ihaleTuru}, ${f.usul.v}`, src: f.usul.src } : f.usul), K.ihale_turu_usulu || ihaleTuru),
      row("İhale tarihi ve saati", f.tarih, K.ihale_tarihi || (tDate ? fmtDate(tDate, true) : "")),
      row("Teklif şekli", f.eteklif), row("Teklif verilecek yer", f.toplanti),
      row("Teslim / iş yeri", f.yer, K.yer || t.city), row("Süre", f.sure || f.teslimSure, K.sure),
      row("Sözleşme türü", f.sozTuru, K.sozlesme_turu), row("Kısmi teklif", f.kismi),
      row("Miktar ve tür", f.miktar, K.kalem_sayisi), ["İKN", t.ikn], ["EKAP", t.ekapUrl], ["İlan", t.ilanUrl]
    ], "Künye bilgisi dokümanlarda bulunamadı."));

    // ---- 3. Kapsam
    children.push(H1(++n, "İşin Kapsamı"));
    const kapsam = (ai.kapsam || []).map(tidy).filter(useful);
    if (kapsam.length) children.push(...bullets(kapsam));
    if (tech.scope) {
      if (kapsam.length) children.push(H2("Teknik şartnamede tanımlanan kapsam"));
      children.push(para([run(tech.scope.v, { size: 20 }), ...cite(tech.scope.src)], { line: 288 }));
    }
    if (!kapsam.length && !tech.scope) children.push(f.miktar ? para([run(f.miktar.v, { size: 20 }), ...cite(f.miktar.src)]) : none("Kapsam bilgisi dokümanlarda bulunamadı."));
    if (tech.heads?.length) { children.push(H2("Teknik şartname bölümleri")); children.push(text(tech.heads.join("   ·   "), { size: 18, color: C.grey })); }

    // ---- 4. Kalem listesi
    children.push(H1(++n, "Kalem Listesi"));
    const tidyName = (window.TR_PROJE && window.TR_PROJE.core.tidyItemName) || ((x) => x);
    const items = (s.items && s.items.length) ? s.items.map((i) => [i.no, tidyName(i.name), qty(i.qty), i.unit])
      : (ai.ana_kalemler || []).filter((i) => useful(i.ad)).map((i, k) => [String(k + 1), tidyName(i.ad), i.miktar, i.birim]);
    if (items.length) {
      const W = [800, CONTENT_W - 800 - 1500 - 1400, 1500, 1400];
      children.push(text(`Toplam ${items.length} kalem.`, { size: 18, color: C.grey, after: 80 }));
      children.push(table(W, [headRow(["No", "Kalem", "Miktar", "Birim"], W, [undefined, undefined, AlignmentType.RIGHT]),
        ...items.map((r, i) => new TableRow({ cantSplit: true, children: [bodyCell(r[0], W[0], i), bodyCell(r[1], W[1], i), bodyCell(r[2], W[2], i, AlignmentType.RIGHT), bodyCell(r[3], W[3], i)] }))]));
    } else children.push(none(f.kalemIlan ? `İdari şartnameye göre ${f.kalemIlan.v} kalem bulunmaktadır; birim fiyat cetveli incelenmemiştir.` : "Birim fiyat teklif cetveli / mal listesi incelenmemiştir."));
    if (tech.quantities?.length && !items.length) { children.push(H2("Teknik şartnamede geçen miktarlar")); children.push(...bullets(tech.quantities.map((q) => `${q.qty} × ${q.name}`))); }

    // ---- 5. Teknik gereksinimler
    children.push(H1(++n, "Teknik Gereksinimler"));
    const teknik = (ai.teknik_gereksinimler || []).map(tidy).filter(useful);
    if (teknik.length) children.push(...bullets(teknik));
    else if (tech.requirements?.length) children.push(...bullets(tech.requirements.slice(0, 8).map((r) => [run(r.v, { size: 20 }), ...cite(r.src)])));
    const brands = (tech.brands || []).map((x) => x.k);
    children.push(...kvTable([
      ["Standartlar", (tech.standards || []).map((x) => x.k).join(", ")],
      ["Marka atıfları", brands.length ? brands.join(", ") + (tech.muadil ? " (muadil/eşdeğer kabul ediliyor)" : " (muadil ifadesi bulunmuyor)") : ""],
      ["Garanti", f.garanti?.v, f.garanti?.src], ["Eğitim", f.egitim?.v, f.egitim?.src],
      ["Kabul testleri", f.fat || f.sat ? [f.fat && "Fabrika kabul testi (FAT)", f.sat && "Saha kabul testi (SAT)"].filter(Boolean).join(", ") : "", (f.fat || f.sat)?.src],
      ["Yedek parça", f.yedek?.v, f.yedek?.src]
    ]));
    if (!teknik.length && !tech.requirements?.length && !(tech.standards || []).length) children.push(none("Teknik şartname incelenmemiştir."));

    // ---- 6. Yeterlik ve mali şartlar
    children.push(H1(++n, "Yeterlik ve Mali Şartlar"));
    children.push(...kvTable([
      ["İş deneyimi", f.deneyim ? `Teklif bedelinin asgari ${f.deneyim.v} oranında` : "", f.deneyim?.src], ["Benzer iş", f.benzerIs?.v, f.benzerIs?.src],
      ["Geçici teminat", f.gecici ? `Teklif bedelinin ${f.gecici.v} oranında` : "", f.gecici?.src], ["Kesin teminat", f.kesin ? `İhale bedelinin ${f.kesin.v} oranında` : "", f.kesin?.src],
      ["Fiyat farkı", f.fiyatFarki?.v, f.fiyatFarki?.src], ["Avans", f.avans?.v, f.avans?.src],
      ["Yerli istekli avantajı", f.yerli?.v, f.yerli?.src], ["Sınır değer katsayısı (N)", f.sinir?.v, f.sinir?.src],
      ["Teklif geçerlilik süresi", f.gecerlilik?.v, f.gecerlilik?.src], ["Gecikme cezası", f.ceza?.v, f.ceza?.src], ["Alt yüklenici", f.altYuk?.v, f.altYuk?.src]
    ]));
    const mali = (ai.yeterlik_ve_mali_sartlar || []).map(tidy).filter(useful);
    if (mali.length) { children.push(H2("Diğer hususlar")); children.push(...bullets(mali)); }
    if (!mali.length && !["deneyim", "gecici", "kesin", "fiyatFarki", "benzerIs"].some((k) => f[k])) children.push(none("İdari şartname incelenmemiştir."));

    // ---- 7. Riskler ve dikkat edilecekler
    children.push(H1(++n, "Riskler ve Dikkat Edilecek Hususlar"));
    const risks = [...(s.flags || []).filter((x) => x.level === "warn").map((x) => tidy(x.text)), ...(ai.riskler || []).map(tidy), ...(s.flags || []).filter((x) => x.level !== "warn").map((x) => tidy(x.text))].filter(useful);
    const seen = new Set();
    const uniq = risks.filter((r) => { const k = r.toLocaleLowerCase("tr-TR").slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; });
    children.push(...(uniq.length ? bullets(uniq) : [none("Belirgin bir risk tespit edilmemiştir.")]));

    // ---- 8. Açıklama talebi soruları
    const sorular = (ai.sorulacak_sorular || []).map(tidy).filter(useful);
    if (sorular.length) {
      children.push(H1(++n, "Açıklama Talebi Konuları"));
      const aGun = f.aciklamaGun?.v || 10;
      if (tDate && daysLeft > 0) children.push(text(`Açıklama taleplerinin en geç ${new Date(tDate - aGun * 864e5).toLocaleDateString("tr-TR")} tarihine kadar (ihale tarihinden ${aGun} gün önce) idareye iletilmesi gerekmektedir.`, { size: 19, color: C.grey }));
      children.push(...bullets(sorular, "num"));
    }
    // ---- 9. Eksik / belirsiz
    const missingTypes = (s.missing || []).map((m) => TYPE_LONG[m] || m);
    const eksik = [...(ai.eksik_veya_belirsiz || []).map(tidy).filter(useful), ...(missingTypes.length ? [`İncelenmeyen doküman: ${missingTypes.join(", ")}.`] : [])];
    // Okunamayan kısımlar: özet dokümanların tamamını kapsıyorsa onun bildirdikleri, aksi halde doküman taramasının bulguları
    const aiCovers = ai.at && Array.isArray(ai.fileIds) && (rec.files || []).every((x) => ai.fileIds.includes(x.id));
    const unread = (aiCovers ? [...(ai.skipped || []), ...(ai.okunamayan_kisimlar || [])] : (s.unread || []).map((u) => `${u.name} — ${u.text}`))
      .map((x) => tidy(String(x).replace(/\s—\s/, ": "))).filter(useful);
    if (eksik.length || unread.length) {
      children.push(H1(++n, "Eksik veya Belirsiz Bilgiler"));
      if (eksik.length) children.push(...bullets(eksik));
      if (unread.length) {
        children.push(H2("Okunamayan kısımlar"));
        children.push(text("Aşağıdaki kısımlar okunamadığı için bu raporda yer almayabilir; ilgili sayfalar dokümanın aslından kontrol edilmelidir.", { size: 19, color: C.grey }));
        children.push(...bullets(unread));
      }
    }

    // ---- Ek: incelenen dokümanlar
    children.push(H1("", "Ek — İncelenen Dokümanlar"));
    const docs = rec.files || [];
    if (docs.length) {
      const W = [CONTENT_W - 2700 - 1000 - 1300, 2700, 1000, 1300];
      children.push(table(W, [headRow(["Dosya", "Doküman türü", "Sayfa", "Durum"], W),
        ...docs.map((d, i) => new TableRow({ cantSplit: true, children: [bodyCell(d.name, W[0], i), bodyCell(TYPE_LONG[d.type] || d.type, W[1], i), bodyCell(String(d.pages || "—"), W[2], i),
          bodyCell(d.error ? "Okunamadı" : d.scanned ? "Taranmış görüntü" : "İncelendi", W[3], i)] }))]));
    } else children.push(none("Doküman bulunmuyor."));
    children.push(text("", { after: 120 }));
    children.push(text("Bu rapor, ilgili ihalenin doküman paketi esas alınarak hazırlanmıştır. Parantez içindeki atıflar bilginin yer aldığı doküman ve sayfayı gösterir. " +
      "Teklif kararı ve fiyatlandırma öncesinde ihale dokümanlarının aslı ve yayımlanan zeyilnameler esas alınmalıdır.", { size: 16, color: C.grey, italics: true, line: 252 }));

    // ---- Üst / alt bilgi
    const header = new Header({ children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 4 } }, spacing: { after: 0 },
      children: [run("İhale Özet Raporu", { size: 16, color: C.grey, caps: true, spacing: 10 }),
        run(`\t${t.ikn ? "İKN " + t.ikn : reportNo}`, { size: 16, color: C.grey })]
    })] });
    const footer = new Footer({ children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.line, space: 4 } },
      children: [run(`Hazırlayan: ${AUTHOR}   |   ${fmtDate(now)}`, { size: 16, color: C.grey }),
        new TextRun({ children: ["\tSayfa ", PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: C.grey })]
    })] });

    const doc = new Document({
      creator: AUTHOR, lastModifiedBy: AUTHOR, title: `İhale Özet Raporu — ${title}`, subject: idare,
      styles: { default: { document: { run: { font: FONT, size: 21, color: C.text } } } },
      numbering: { config: [
        { reference: "dot", levels: [{ level: 0, format: LevelFormat.BULLET, text: "▪", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 260 } }, run: { color: C.navy, size: 16 } } }] },
        { reference: "num", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 440, hanging: 320 } }, run: { color: C.navy, bold: true } } }] }
      ] },
      sections: [{ properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: 1134, bottom: 1134, left: MARGIN, right: MARGIN, header: 567, footer: 567 } } },
        headers: { default: header }, footers: { default: footer }, children }]
    });
    const blob = await Packer.toBlob(doc);
    const name = `Ihale_Ozet_Raporu_${t.ikn ? safeFile(t.ikn.replace("/", "-")) + "_" : ""}${safeFile(title)}_${now.toISOString().slice(0, 10)}.docx`;
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
