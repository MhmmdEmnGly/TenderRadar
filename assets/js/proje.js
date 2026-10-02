/*
 * Tender Radar — Proje özeti
 * İhale dokümanlarını (EKAP ZIP'i, PDF, DOCX, XLSX…) tarayıcıda okur, türlerine ayırır (idari / teknik şartname,
 * birim fiyat cetveli, sözleşme tasarısı…) ve ihalenin künyesini, kapsamını, kalem listesini, teknik öne çıkanlarını,
 * yeterlik ve mali şartlarını, dikkat edilecek noktaları çıkarır. Dosyalar sunucuya değil, kullanıcının kendi
 * Supabase alanına (özel depolama) yüklenir. İsteğe bağlı olarak kullanıcının kendi Claude API anahtarıyla
 * yapay zekâ özeti üretilir (anahtar yalnızca o tarayıcıda saklanır).
 */
(function () {
  "use strict";

  const LIB = {
    pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
    zip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
    xlsx: "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
    sdk: "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm"
  };
  const BUCKET = "ihale-dokuman";
  const MAX_TEXT = 400000;          // belge başına saklanan metin (karakter)
  const SUMMARY_V = 3;              // okuyucu/çıkarım değişince artırılır; eski özetler açılışta yeniden hesaplanır
  const MAX_UPLOAD = 50 * 1024 * 1024;
  // Yapay zekâ sağlayıcıları: anahtarlar yalnızca bu tarayıcıda (localStorage) saklanır, veritabanına yazılmaz
  const PROVIDERS = {
    gemini: { label: "Gemini", note: "ücretsiz kota", keyStore: "tr.geminiKey", keyOk: (k) => /^[\w.-]{30,}$/.test(k), keyHint: "AIza… ya da AQ.…",
      keyUrl: "https://aistudio.google.com/apikey", keySite: "aistudio.google.com" },
    claude: { label: "Claude", note: "ücretli", keyStore: "tr.anthropicKey", keyOk: (k) => /^sk-ant-/.test(k), keyHint: "sk-ant-…",
      keyUrl: "https://console.anthropic.com/settings/keys", keySite: "console.anthropic.com" }
  };
  const PROV_STORE = "tr.aiProvider";
  const CLAUDE_MODEL = "claude-opus-5-5";
  const GEMINI_MODELS = [["gemini-3.7-flash", "Gemini 3.7 Flash (önerilen)"], ["gemini-3.8-flash", "Gemini 3.8 Flash (en yeni, yoğun olabilir)"],
    ["gemini-3.5-flash", "Gemini 3.5 Flash"], ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite (en yüksek kota)"]];
  // Seçili model yoğunsa (503), kotası dolduysa (429) ya da kaldırıldıysa (404) sırayla denenecek modeller
  const GEMINI_CHAIN = ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  const GMODEL_STORE = "tr.geminiModel";
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* depolama kapalı */ } };
  const provider = () => (PROVIDERS[lsGet(PROV_STORE)] ? lsGet(PROV_STORE) : "gemini");

  // ---------- Kütüphane yükleme ----------
  const loaded = {};
  function loadScript(src) {
    return loaded[src] || (loaded[src] = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error("Kütüphane yüklenemedi (internet bağlantısını kontrol et): " + src.split("/").pop())); };
      document.head.appendChild(s);
    }));
  }
  async function pdfLib() { await loadScript(LIB.pdf); window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB.pdfWorker; return window.pdfjsLib; }
  async function zipLib() { await loadScript(LIB.zip); return window.JSZip; }
  async function xlsxLib() { await loadScript(LIB.xlsx); return window.XLSX; }

  // ---------- Metin yardımcıları ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FOLD = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
  const fold = (s) => String(s || "").toLocaleLowerCase("tr-TR").replace(/[çğıöşüâîû]/g, (c) => FOLD[c]);
  const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/^[\s:;,.\-–]+|[\s;,\-–]+$/g, "").replace(/([^.])\.$/, "$1").trim();
  const cut = (s, n) => { s = clean(s); if (s.length <= n) return s; const i = s.lastIndexOf(" ", n); return s.slice(0, i > n * 0.6 ? i : n) + "…"; };
  const sentenceCut = (s, n) => { s = clean(s); if (s.length <= n) return s; const i = s.lastIndexOf(". ", n); return i > n * 0.4 ? s.slice(0, i + 1) : cut(s, n); };
  // Cümle ortasından başlayan yakalamaların baştaki yarım kelimesini at ("tlerinden sonra…" → "sonra…")
  const dropFragment = (s) => String(s).replace(/^[a-zçğıöşü]\S*\s+/, "");
  const extOf = (n) => (String(n).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || "";
  const uid = () => Math.random().toString(36).slice(2, 10);
  function trNum(v) {
    let s = String(v || "").replace(/\s/g, "");
    if (!/\d/.test(s)) return NaN;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    return parseFloat(s);
  }
  const fmtQty = (n) => (isFinite(n) ? n.toLocaleString("tr-TR", { maximumFractionDigits: 3 }) : "");
  const decodeEntities = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, "&");

  // ZIP içindeki eski (UTF-8 bayrağı olmayan) Türkçe dosya adları genellikle CP857 kodludur
  const CP857 = { 0x80: "Ç", 0x81: "ü", 0x82: "é", 0x83: "â", 0x84: "ä", 0x85: "à", 0x87: "ç", 0x88: "ê", 0x89: "ë", 0x8a: "è", 0x8b: "ï", 0x8c: "î",
    0x8d: "ı", 0x8e: "Ä", 0x90: "É", 0x93: "ô", 0x94: "ö", 0x95: "ò", 0x96: "û", 0x97: "ù", 0x98: "İ", 0x99: "Ö", 0x9a: "Ü", 0x9e: "Ş", 0x9f: "ş",
    0xa0: "á", 0xa1: "í", 0xa2: "ó", 0xa3: "ú", 0xa4: "ñ", 0xa5: "Ñ", 0xa6: "Ğ", 0xa7: "ğ" };
  function decodeZipName(bytes) {
    const b = Array.from(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(b)); } catch { /* UTF-8 değil */ }
    return b.map((c) => (c < 0x80 ? String.fromCharCode(c) : CP857[c] || "_")).join("");
  }

  // ---------- Dosya okuyucular ----------
  async function readPdf(buf) {
    const lib = await pdfLib();
    const pdf = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let r = null;
        for (let i = rows.length - 1; i >= 0 && i >= rows.length - 40; i--) if (Math.abs(rows[i].y - y) < 3) { r = rows[i]; break; }
        if (!r) rows.push((r = { y, parts: [] }));
        r.parts.push({ x, s: it.str, w: it.width || 0 });
      }
      rows.sort((a, b) => b.y - a.y);
      pages.push(rows.map((r) => {
        r.parts.sort((a, b) => a.x - b.x);
        let out = "", end = null;
        for (const q of r.parts) {
          if (end != null) {
            const gap = q.x - end;
            if (gap > 14) out += " | ";
            else if (gap > 1.2 && !/\s$/.test(out) && !/^\s/.test(q.s)) out += " ";
          }
          out += q.s; end = q.x + q.w;
        }
        return out.replace(/\s+$/, "");
      }).join("\n"));
      page.cleanup();
    }
    const text = pages.join("\n\f");
    const letters = (text.match(/\p{L}/gu) || []).length;
    return { text, pages: pdf.numPages, scanned: letters < 60 * pdf.numPages * 0.5 && letters < 400 };
  }
  async function readDocx(buf) {
    const JSZip = await zipLib();
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file("word/document.xml");
    if (!f) throw new Error("DOCX içeriği bulunamadı");
    let xml = await f.async("string");
    xml = xml.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) => row.replace(/<\/w:p>/g, " ").replace(/<\/w:tc>/g, " | ") + "\n");
    xml = xml.replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "");
    return { text: decodeEntities(xml).replace(/[ \t]+\n/g, "\n").replace(/ \| \n/g, "\n").replace(/\n{3,}/g, "\n\n"), pages: null };
  }
  async function readSheet(buf) {
    const X = await xlsxLib();
    const wb = X.read(buf, { type: "array" });
    const out = [];
    for (const n of wb.SheetNames) {
      const rows = X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, blankrows: false, defval: "" });
      out.push("## " + n);
      for (const r of rows) {
        const cells = r.map((c) => String(c).replace(/\s+/g, " ").trim());
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.some(Boolean)) out.push(cells.join(" | "));
      }
    }
    return { text: out.join("\n"), pages: null, sheet: true };
  }
  // Eski Word (.doc) ikili biçimi: metin parçaları UTF-16 ya da Windows-1254 olarak saklanır; yaklaşık okunur
  function readLegacyDoc(buf) {
    const u8 = new Uint8Array(buf);
    const pick = (s, rx) => (s.match(rx) || []).filter((r) => /\p{L}{3}/u.test(r)).join("\n");
    let a = "", b = "";
    try { a = pick(new TextDecoder("utf-16le").decode(u8), /[\p{L}\p{N}\p{P}\p{Zs}\r\t]{8,}/gu); } catch { /* yok */ }
    try { b = pick(new TextDecoder("windows-1254").decode(u8), /[A-Za-zÇĞİÖŞÜçğıöşü0-9 .,;:()%\/\-'"\r\t]{16,}/g); } catch { /* yok */ }
    const score = (s) => (s.match(/\b(ve|ile|için|olarak|bir|bu|edilecektir)\b/gi) || []).length;
    const text = (score(a) >= score(b) ? a : b).replace(/\r/g, "\n");
    return { text, pages: null, approx: true };
  }

  // EKAP ve idarelerin verdiği ".doc" dosyalarının çoğu aslında Word'ün kaydettiği HTML / MHT / Word-XML / RTF'tir.
  // Uzantıya değil içeriğe bakarak doğru okuyucuyu seç.
  function sniffKind(buf) {
    const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, Math.min(4096, buf.byteLength)));
    if (/^PK\x03\x04/.test(head)) return "zip";
    if (/^\s*\{\\rtf/.test(head)) return "rtf";
    if (/^MIME-Version:/im.test(head) && /multipart\/related/i.test(head)) return "mht";
    if (/<w:wordDocument|<\?mso-application[^>]*Word\.Document/i.test(head)) return "wordxml";
    if (/<(html|!doctype html|head|body|meta|div|p|table)[\s>]/i.test(head) || /xmlns:o="urn:schemas-microsoft-com/i.test(head)) return "html";
    if (/^\xD0\xCF\x11\xE0/.test(head)) return "ole";   // gerçek eski Word ikili dosyası
    return "";
  }
  // Bayt dizisini doğru karakter kümesiyle çöz (UTF-8 değilse Türkçe Windows-1254)
  function decodeBytes(u8, hint) {
    const cs = String(hint || "").toLowerCase().replace(/^iso-8859-9$/, "windows-1254");
    if (cs && !/utf-?8/.test(cs)) { try { return new TextDecoder(cs).decode(u8); } catch { /* bilinmeyen kodlama */ } }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch { return new TextDecoder("windows-1254").decode(u8); }
  }
  // DOM'u satır/hücre yapısını koruyarak düz metne çevir (Word HTML'i, Word 2003 XML'i)
  const BLOCK = new Set(["p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "article", "ul", "ol", "blockquote", "pre", "dt", "dd"]);
  function domToText(root) {
    let out = "";
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, " "); return; }
      if (n.nodeType !== 1) return;
      const tag = (n.localName || n.nodeName || "").toLowerCase();
      if (["style", "script", "head", "title", "xml", "binData", "o:documentproperties"].includes(tag)) return;
      if (tag === "tab") { out += "\t"; return; }
      for (const c of n.childNodes) walk(c);
      if (tag === "td" || tag === "th" || tag === "tc") out += " | ";
      else if (BLOCK.has(tag)) out += "\n";
    };
    walk(root);
    return out.replace(/[ \t]*\|[ \t]*\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function readHtmlText(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("style,script,head,xml,title").forEach((x) => x.remove());
    return domToText(doc.body || doc.documentElement);
  }
  function readHtmlLike(buf, kind) {
    const u8 = new Uint8Array(buf);
    if (kind === "mht") {
      const raw = new TextDecoder("latin1").decode(u8);
      const bnd = (raw.match(/boundary="?([^"\r\n;]+)"?/i) || [])[1];
      const partsMht = bnd ? raw.split("--" + bnd) : [raw];
      const part = partsMht.find((p) => /Content-Type:\s*text\/html/i.test(p)) || partsMht[1] || raw;
      const cs = (part.match(/charset="?([\w-]+)"?/i) || [])[1];
      const sep = part.search(/\r?\n\r?\n/);
      let body = sep >= 0 ? part.slice(sep).trim() : part;
      let bytes;
      if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(part)) {
        body = body.replace(/=\r?\n/g, "");
        const arr = [];
        for (let i = 0; i < body.length; i++) {
          if (body[i] === "=" && /^[0-9A-F]{2}$/i.test(body.substr(i + 1, 2))) { arr.push(parseInt(body.substr(i + 1, 2), 16)); i += 2; }
          else arr.push(body.charCodeAt(i) & 255);
        }
        bytes = new Uint8Array(arr);
      } else if (/Content-Transfer-Encoding:\s*base64/i.test(part)) {
        bytes = Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
      } else bytes = Uint8Array.from(body, (c) => c.charCodeAt(0) & 255);
      return { text: readHtmlText(decodeBytes(bytes, cs)), pages: null };
    }
    const latin = new TextDecoder("latin1").decode(u8.subarray(0, Math.min(8192, u8.length)));
    const cs = (latin.match(/charset\s*=\s*["']?([\w-]+)/i) || latin.match(/encoding="([\w-]+)"/i) || [])[1];
    const str = decodeBytes(u8, cs);
    if (kind === "wordxml") {
      const xml = new DOMParser().parseFromString(str, "application/xml");
      return { text: domToText(xml.documentElement), pages: null };
    }
    return { text: readHtmlText(str), pages: null };
  }
  // RTF: kontrol kelimelerini at, \'xx (Windows-1254) ve \uN karakterlerini çöz
  function readRtf(buf) {
    const s = new TextDecoder("latin1").decode(new Uint8Array(buf));
    const cp = new TextDecoder("windows-1254");
    let out = "", depth = 0;
    const skipAt = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "{") { depth++; if (/^\{\\\*|^\{\\(fonttbl|colortbl|stylesheet|info|pict|object|themedata|datastore|latentstyles)/.test(s.slice(i, i + 16))) skipAt.push(depth); continue; }
      if (c === "}") { if (skipAt[skipAt.length - 1] === depth) skipAt.pop(); depth--; continue; }
      const skipping = skipAt.length > 0;
      if (c === "\\") {
        const nx = s[i + 1];
        if (nx === "'") { if (!skipping) out += cp.decode(new Uint8Array([parseInt(s.substr(i + 2, 2), 16)])); i += 3; continue; }
        if (nx === "\\" || nx === "{" || nx === "}") { if (!skipping) out += nx; i++; continue; }
        const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(s.slice(i, i + 40));
        if (!m) { i++; continue; }
        i += m[0].length - 1;
        if (skipping) continue;
        const w = m[1];
        if (w === "par" || w === "line" || w === "row" || w === "sect" || w === "page") out += "\n";
        else if (w === "tab") out += "\t";
        else if (w === "cell") out += " | ";
        else if (w === "u" && m[2]) { let code = +m[2]; if (code < 0) code += 65536; out += String.fromCharCode(code); if (s[i + 1] === "?") i++; }
        continue;
      }
      if (!skipping && c !== "\r" && c !== "\n") out += c;
    }
    return { text: out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), pages: null };
  }

  // Daha önce yanlış okunmuş metinlerdeki HTML kalıntılarını onar: "ccedil;" → ç, "nbsp;" → boşluk, stil parçalarını sil
  const ENT = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ccedil: "ç", Ccedil: "Ç", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü",
    acirc: "â", Acirc: "Â", icirc: "î", Icirc: "Î", ucirc: "û", Ucirc: "Û", ecirc: "ê", eacute: "é", Eacute: "É", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú",
    agrave: "à", egrave: "è", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", sbquo: "‚", bdquo: "„", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·",
    deg: "°", sup2: "²", sup3: "³", times: "×", divide: "÷", plusmn: "±", ordm: "º", ordf: "ª", laquo: "«", raquo: "»", euro: "€", shy: "", zwnj: "", zwj: "", lrm: "", rlm: "" };
  const CSS_PROPS = "text-align|text-underline|text-decoration|text-indent|text-autospace|text-justify|mso-[\\w-]+|font-[\\w-]+|margin(?:-[\\w-]+)?|line-height|tab-stops|layout-grid-mode|vertical-align|letter-spacing|word-spacing|punctuation-wrap|page-break-[\\w-]+|border(?:-[\\w-]+)?|padding(?:-[\\w-]+)?|background(?:-[\\w-]+)?|color|width|height";
  const RX_CSS = new RegExp(`["']?\\s*\\b(?:${CSS_PROPS})\\s*:\\s*[^;"'<>\\n]{0,80};?\\s*["']?`, "gi");
  function repairText(t) {
    if (!t) return t;
    let s = String(t);
    if (!/(?:^|[^A-Za-z])(?:&?(?:[a-zA-Z]{2,8}|#\d{2,5});)|(?:text-align|mso-|text-underline|font-family)\s*:/.test(s)) return s;
    // Eski okuyucu metni "&" işaretinde satıra bölmüştü: "i⏎ccedil;me" → "içme", "ve ⏎ccedil;alışır" → "ve çalışır"
    s = s.replace(/\r?\n&?([a-zA-Z]{2,8});/g, (m, n) => (n in ENT ? ENT[n] : m))
      .replace(/(\p{L})\r?\n&?#?(199|214|220|231|246|252|286|287|304|305|350|351|160|8211|8212|8216|8217|8220|8221);/gu, (m, c, n) => c + String.fromCharCode(+n));
    s = s.replace(/&?#(\d{2,5});/g, (m, n) => String.fromCharCode(+n))
      .replace(/&?\b([a-zA-Z]{2,8});/g, (m, n) => (n in ENT ? ENT[n] : m))
      .replace(RX_CSS, " ")
      .replace(/\b(?:style|class|lang|align)\s*=\s*("[^"]*"|'[^']*')/gi, " ")
      .replace(/(^|\s)["']{1,2}(?=\s|$)/g, "$1")
      .replace(/[ \t]{2,}/g, " ");
    return s;
  }

  // ---------- Belge türü ----------
  const TYPES = {
    idari: "İdari şartname", teknik: "Teknik şartname", cetvel: "Birim fiyat / kalem listesi", sozlesme: "Sözleşme tasarısı",
    ilan: "İhale ilanı", zeyil: "Zeyilname", form: "Standart form", diger: "Diğer"
  };
  const TYPE_ORDER = ["idari", "teknik", "cetvel", "sozlesme", "ilan", "zeyil", "form", "diger"];
  function classify(name, text, sheet) {
    const n = " " + fold(name).replace(/[_\-.()]+/g, " ") + " ";
    const h = fold(String(text || "").slice(0, 4000)).replace(/\s+/g, " ");
    if (/zeyilname/.test(n)) return "zeyil";
    if (/idari sartname|\bidari\b/.test(n)) return "idari";
    if (/teknik/.test(n)) return "teknik";
    if (/birim ?fiyat|teklif ?cetvel|cetvel|mal listesi|malzeme listesi|kesif|metraj|mahal listesi|fiyat teklif|kalem listesi|miktar/.test(n)) return "cetvel";
    if (/sozlesme/.test(n)) return "sozlesme";
    if (/\bilan/.test(n)) return "ilan";
    if (/standart form|\bkik ?\d{3}|\bform\b|beyan|mektub/.test(n)) return "form";
    if (/idari sartname/.test(h)) return "idari";
    if (/teknik sartname/.test(h)) return "teknik";
    if (/birim fiyat teklif cetveli|teklif cetveli|birim fiyat cetveli|mal listesi|kesif ozeti/.test(h)) return "cetvel";
    if (/sozlesme tasarisi|tip sozlesme|sozlesme taslagi/.test(h)) return "sozlesme";
    if (/zeyilname/.test(h)) return "zeyil";
    if (/ihale ilani/.test(h)) return "ilan";
    if (sheet) return "cetvel";
    return "diger";
  }

  // ---------- Dosyaları aç (ZIP içindekiler dahil) ----------
  async function extractFiles(fileList, onStep) {
    const out = [];
    async function one(name, buf, depth, from) {
      const ext = extOf(name);
      if (ext === "zip") {
        if (depth > 3) return;
        onStep && onStep(`ZIP açılıyor: ${name}`);
        const JSZip = await zipLib();
        const zip = await JSZip.loadAsync(buf, { decodeFileName: decodeZipName });
        for (const e of Object.values(zip.files)) {
          if (e.dir || /(^|\/)(__MACOSX|\._)|thumbs\.db$|desktop\.ini$/i.test(e.name)) continue;
          await one(e.name.split("/").pop(), await e.async("arraybuffer"), depth + 1, e.name);
        }
        return;
      }
      const doc = { id: uid(), name, path: from || name, size: buf.byteLength, ext, type: "diger", text: "", pages: null, scanned: false, blob: new Blob([buf]) };
      onStep && onStep(`Okunuyor: ${name}`);
      try {
        let r;
        const kind = ["pdf", "xlsx", "xls", "xlsm", "ods", "csv", "jpg", "jpeg", "png", "webp", "tif", "tiff"].includes(ext) ? "" : sniffKind(buf);
        if (ext === "pdf") r = await readPdf(buf);
        else if (["html", "mht", "wordxml"].includes(kind)) r = readHtmlLike(buf, kind);   // ".doc" görünümlü Word HTML/MHT/XML dosyaları
        else if (kind === "rtf") r = readRtf(buf);
        else if (ext === "docx" || ext === "docm" || (kind === "zip" && ext === "doc")) r = await readDocx(buf);
        else if (["xlsx", "xls", "xlsm", "ods", "csv"].includes(ext)) r = await readSheet(buf);
        else if (ext === "doc" || kind === "ole") r = readLegacyDoc(buf);
        else if (["txt", "rtf", "htm", "html", "mht", "mhtml", "xml"].includes(ext)) r = { text: decodeBytes(new Uint8Array(buf)) };
        else if (["rar", "7z"].includes(ext)) throw new Error(`${ext.toUpperCase()} arşivi tarayıcıda açılamıyor — dosyaları çıkarıp ZIP ya da tek tek yükle`);
        else if (["jpg", "jpeg", "png", "webp", "tif", "tiff"].includes(ext)) r = { text: "", scanned: true, image: true };
        else throw new Error("Desteklenmeyen dosya türü");
        Object.assign(doc, r);
      } catch (e) { doc.error = e.message || String(e); }
      doc.text = repairText(doc.text || "");
      if (doc.text.length > MAX_TEXT) { doc.text = doc.text.slice(0, MAX_TEXT); doc.truncated = true; }
      doc.chars = doc.text.length;
      doc.type = classify(name, doc.text, doc.sheet);
      out.push(doc);
    }
    for (const f of fileList) await one(f.name, await f.arrayBuffer(), 0, null);
    return out;
  }

  // ---------- Çıkarım ----------
  function prep(doc) {
    if (doc._flat != null) return doc;
    let pages = String(doc.text || "").split("\f").map((p) => p.split("\n"));
    // Her sayfada tekrar eden üst/alt bilgi satırlarını (doküman no, telif notu, sayfa no) çıkar
    if (pages.length >= 3) {
      const norm = (l) => l.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
      const cnt = new Map();
      pages.forEach((ls) => new Set(ls.map(norm)).forEach((k) => k && cnt.set(k, (cnt.get(k) || 0) + 1)));
      const lim = Math.max(3, pages.length * 0.4);
      pages = pages.map((ls) => ls.filter((l) => (cnt.get(norm(l)) || 0) < lim));
    }
    doc._flat = pages.map((ls) => ls.join("\n").replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim()).join("\f");
    doc._lines = [];
    pages.forEach((ls, i) => ls.forEach((l) => { if (l.trim()) doc._lines.push({ t: l, page: i + 1 }); }));
    return doc;
  }
  function pageAt(doc, idx) {
    if (!doc.pages) return null;
    let c = 1;
    for (let i = 0; i < idx; i++) if (doc._flat.charCodeAt(i) === 12) c++;
    return c;
  }
  // Belgeleri tür önceliğine göre tarar; ilk eşleşmeyi kaynağıyla (belge, sayfa) döndürür
  function find(docs, types, rxs, pick) {
    const ordered = [...types.flatMap((t) => docs.filter((d) => d.type === t))];
    for (const d of ordered) {
      prep(d);
      for (const rx of rxs) {
        const m = rx.exec(d._flat);
        if (!m) continue;
        const v = pick ? pick(m) : m[1];
        if (v == null || v === "") continue;
        return { v, src: { name: d.name, type: d.type, page: pageAt(d, m.index) } };
      }
    }
    return null;
  }
  const NEXT = String.raw`(?=\s+(?:[a-zçğıöşü]\)|\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\.?\s|\d{1,2}\s*[-–]\s|Madde \d)|\f|$)`;
  const R = (s, f = "u") => new RegExp(s.replace(/NEXT/g, NEXT), f);

  const ADM = ["idari", "ilan", "sozlesme", "zeyil", "diger", "teknik"];
  const CONTRACT = ["sozlesme", "idari", "teknik", "diger"];
  const TECH = ["teknik", "diger", "cetvel", "sozlesme", "idari"];

  function extractFields(docs) {
    const f = {};
    const put = (k, r, fmt) => { if (r) f[k] = { v: fmt ? fmt(r.v) : clean(r.v), src: r.src }; };

    put("idare", find(docs, ADM, [R(String.raw`İdarenin\s*[;:,]?\s*a\)\s*Ad[ıi]\s*:?\s*(.{3,180}?)\s+b\)\s*Adres`),
      R(String.raw`İdarenin\s+ad[ıi]\s*:\s*(.{3,160}?)NEXT`)]), (v) => cut(v, 160));
    put("adres", find(docs, ADM, [R(String.raw`İdarenin\s*[;:,]?\s*a\)[\s\S]{0,200}?b\)\s*Adresi?\s*:?\s*(.{5,220}?)\s+c\)`)]), (v) => cut(v, 200));
    const ta = find(docs, ADM, [R(String.raw`İhale konusu\s+(mal[ıi]n|hizmetin|yap[ıi]m işinin|danışmanlık hizmetinin|işin)`)]);
    if (ta) {
      const k = fold(ta.v);
      f.tur = { v: /^mal/.test(k) ? "Mal alımı" : /^hizmet/.test(k) ? "Hizmet alımı" : /^yap/.test(k) ? "Yapım işi" : /^dan/.test(k) ? "Danışmanlık hizmeti" : "", src: ta.src };
      if (!f.tur.v) delete f.tur;
    }
    put("isAdi", find(docs, ADM, [
      R(String.raw`İhale konusu\s+(?:mal[ıi]n|hizmetin|yap[ıi]m işinin|danışmanlık hizmetinin|işin)\s*[;:,]?\s*a\)\s*Ad[ıi]\s*:?\s*(.{3,300}?)\s+b\)`),
      R(String.raw`(?:İşin|İhalenin|İhale konusu işin)\s+[Aa]d[ıi]\s*:\s*(.{3,250}?)NEXT`)]), (v) => cut(v, 260));
    put("miktar", find(docs, ADM, [R(String.raw`(?:Miktar[ıi] ve türü|Niteliği,? türü ve miktar[ıi]|Niteliği,? türü ve miktar[ıi])\s*:?\s*(.{3,600}?)NEXT`)]), (v) => cut(v, 420));
    put("yer", find(docs, ADM, [R(String.raw`(?:Teslim (?:edileceği )?[Yy]er(?:i)?|[İi]şin [Yy]apılacağı [Yy]er(?:i)?|Yapılacağı [Yy]er(?:\/teslim yeri)?)\s*[:：]\s*(.{3,320}?)NEXT`)]), (v) => cut(v, 260));
    put("sure", find(docs, ["idari", "ilan", "zeyil"], [
      R(String.raw`(?:Teslim tarihi|[İi]şin süresi|Yapım [Ss]üresi|Süresi|Teslim süresi|İşe başlama ve bitiş tarihleri)\s*[:：]\s*(?:\d{1,2}(?:\.\d{1,2}){1,3}\.?\s+)?(.{3,420}?)NEXT`)]), (v) => cut(v, 300));
    put("usul", find(docs, ADM, [R(String.raw`İhale [Uu]sulü\s*:?\s*(.{3,300}?)NEXT`)]), (v) => {
      const k = /(açık ihale(?: usulü)?|belli istekliler arasında ihale(?: usulü)?|pazarlık usulü(?: \(\d+\/[a-z]\))?|doğrudan temin|elektrik dağıtım şirketleri[^.]{0,70}yönetmeliği|21\/[a-zç]\)?)/i.exec(v);
      return k ? k[1].charAt(0).toLocaleUpperCase("tr-TR") + k[1].slice(1) : cut(v, 90);
    });
    const dt = find(docs, ADM, [R(String.raw`(?:İhale|[Tt]eklif(?:lerin)?\s+(?:son\s+)?(?:verme|teslim))[^\d\f]{0,70}?(\d{1,2}[./]\d{1,2}[./]\d{4})(?:\D{0,40}?(\d{1,2}[:.]\d{2}))?`)],
      (m) => m[1].replace(/\//g, ".") + (m[2] ? " " + m[2].replace(".", ":") : ""));
    if (dt) f.tarih = { v: dt.v, src: dt.src };
    const et = find(docs, ADM, [R(String.raw`(e-teklif|elektronik ortamda (?:teklif|alınacak)|EKAP üzerinden (?:alınacak|verilecek|teklif))`, "iu")]);
    if (et) f.eteklif = { v: "e-teklif (EKAP, e-imza gerekir)", src: et.src };
    put("toplanti", find(docs, ADM, [R(String.raw`(?:toplantı yeri|İhale komisyonunun toplantı yeri|[Tt]ekliflerin (?:verileceği|sunulacağı) (?:adres|yer))\s*(?:\(e-tekliflerin açılacağı adres\))?\s*:?\s*(.{3,220}?)NEXT`)]), (v) => cut(v, 200));

    // Yeterlik ve mali şartlar
    put("deneyim", find(docs, ADM, [
      R(String.raw`(?:[İi]ş deneyim|deneyimini gösteren|deneyim belge)[^%\f]{0,320}?%\s*(\d{1,3})`),
      R(String.raw`[Bb]enzer iş(?:e ilişkin)?[^%\f]{0,200}?(?:teklif edilen|teklif ettiği)[^%\f]{0,40}?%\s*(\d{1,3})`)]), (v) => "%" + v);
    put("benzerIs", find(docs, ADM, [
      R(String.raw`[Bb]u ihalede benzer iş olarak\s*[;:,]?\s*(.{5,450}?)\s*(?:kabul edilecektir|dikkate alınacaktır|benzer iş sayılacaktır|kabul edilir)`),
      R(String.raw`[Bb]enzer iş olarak kabul edilecek (?:işler|mallar|hizmetler)\s*(?:aşağıda belirtilmiştir)?\s*[:;]?\s*(.{5,600}?)(?=\s+\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\.?\s|\f|$)`)]), (v) => cut(v, 380));
    const st = find(docs, ADM, [R(String.raw`(anahtar teslimi götürü bedel|teklif birim fiyat|götürü bedel)[^.\f]{0,60}?(?:üzerinden|alınarak|sözleşme imzala)`, "iu")]);
    if (st) f.sozTuru = { v: /birim/i.test(st.v) ? "Teklif birim fiyat" : /anahtar/i.test(st.v) ? "Anahtar teslimi götürü bedel" : "Götürü bedel", src: st.src };
    const kt = find(docs, ADM, [R(String.raw`[Kk]ısmi teklif\s*(verilemez|verilebilir|verilmesine izin verilmemektedir|verilemeyecektir|verilebilecektir|kabul edilmeyecektir|kabul edilecektir)`)]);
    if (kt) f.kismi = { v: /(emez|mez|miyor|memektedir|meyecek|mayacak)/.test(kt.v) ? "Verilemez" : "Verilebilir", src: kt.src };
    put("gecici", find(docs, ADM, [R(String.raw`[Gg]eçici teminat[^%\f]{0,220}?%\s*([\d,]+)`)]), (v) => "%" + v);
    put("kesin", find(docs, ADM, [R(String.raw`(?:bedelinin|bedeli üzerinden)[^%\f]{0,60}?%\s*([\d,]+)['’]?\w*\s+oranında kesin teminat`), R(String.raw`[Kk]esin teminat[^%\f]{0,220}?%\s*([\d,]+)`)]), (v) => "%" + v);
    const ff = find(docs, ADM.concat(["sozlesme"]), [R(String.raw`[Ff]iyat farkı\s*(?:hesaplanmayacak|hesaplanacak|verilmeyecek|verilecek|ödenmeyecek|ödenecek|hesaplanmaz|verilmez|ödenmez)\w*`)]);
    if (ff) { const s = fold(ff.v); f.fiyatFarki = { v: /(mayacak|meyecek|maz\b|mez\b)/.test(s) ? "Verilmeyecek" : "Verilecek", src: ff.src }; }
    const av = find(docs, ADM.concat(["sozlesme"]), [R(String.raw`[Aa]vans\s*(?:verilmeyecek|verilecek|ödenmeyecek|ödenecek|verilmez)\w*`)]);
    if (av) { const s = fold(av.v); f.avans = { v: /(meyecek|mez\b)/.test(s) ? "Verilmeyecek" : "Verilecek", src: av.src }; }
    const yr = find(docs, ADM, [R(String.raw`yerli (?:malı teklif eden )?istekli(?:ler)?(?: lehine)?[^%\f]{0,180}?%\s*(\d{1,2})`), R(String.raw`%\s*(\d{1,2})[^.\f]{0,90}?fiyat avantajı`)]);
    if (yr) f.yerli = { v: "%" + yr.v + " fiyat avantajı", src: yr.src };
    put("sinir", find(docs, ADM, [R(String.raw`[Ss]ınır değer[^\f]{0,500}?\bN\b[^\d\f]{0,40}?(\d[,.]\d{1,2})`)]));
    put("gecerlilik", find(docs, ADM, [R(String.raw`[Tt]ekliflerin geçerlilik süresi[^\d\f]{0,90}?(\d{2,3})\s*(?:\([^)]{0,25}\))?\s*takvim günü`)]), (v) => v + " takvim günü");
    const ay = find(docs, ADM, [R(String.raw`açıklama[^.\f]{0,160}?ihale tarihinden\s*(?:en geç\s*)?(\d{1,2}|on|yedi|beş|üç)\s*(?:\([^)]{0,10}\)\s*)?(?:gün|iş günü) önce`)]);
    if (ay) { const w = { on: 10, yedi: 7, beş: 5, üç: 3 }; f.aciklamaGun = { v: +(w[ay.v] || ay.v), src: ay.src }; }
    const alt = find(docs, ADM, [R(String.raw`([^.\f]{0,120}alt yüklenici(?:ye|lere)?\s+(?:yaptırılamaz|yaptırılabilir|yaptırılmayacaktır|çalıştırılabilir|çalıştırılamaz|verilebilir|verilemez|devredilemez)[^.\f]{0,80})`)]);
    if (alt) f.altYuk = { v: cut(alt.v, 220), src: alt.src };
    put("ceza", find(docs, CONTRACT, [
      R(String.raw`(?:gecikme|geciken her|gecikilen her)[^.\f]{0,240}?((?:binde|yüzde|%)\s*[\d,]+(?:\s*\([^)]{0,20}\))?)`),
      R(String.raw`((?:binde|yüzde|%)\s*[\d,]+(?:\s*\([^)]{0,20}\))?)[^.\f]{0,140}?gecikme cezası`)]));

    // Sözleşme ve teknik şartnameden
    put("teslimSure", find(docs, CONTRACT, [R(String.raw`(?:[Tt]eslim|[İi]şin|[Ss]özleşmenin)\s+süresi[^.\d\f]{0,80}?(\d{1,4}\s*(?:\([^)]{0,25}\)\s*)?(?:takvim günü|iş günü|gün|ay|yıl))`)]));
    put("garanti", find(docs, TECH, [
      R(String.raw`[Gg]aranti süresi[^.\d\f]{0,80}?(\d{1,2}\s*(?:\([^)\d]{0,15}\)\s*)?(?:yıl|ay|sene))`),
      R(String.raw`(\d{1,2}\s*(?:\([^)\d]{0,15}\)\s*)?(?:yıl|ay|sene))[^.\f]{0,30}?garanti`)]));
    put("egitim", find(docs, TECH, [R(String.raw`([^.\f]{0,80}eğitim[^.\f]{0,140}?\d{1,3}\s*(?:kişi|gün|saat|personel|iş günü)[^.\f]{0,60})`),
      R(String.raw`([^.\f]{0,80}\d{1,3}\s*(?:kişi\w*|gün|saat|personel\w*)[^.\f]{0,60}eğitim[^.\f]{0,60})`)]), (v) => cut(dropFragment(v), 200));
    const fat = find(docs, TECH, [R(String.raw`(\bFAT\b|[Ff]abrika [Kk]abul)`)]);
    if (fat) f.fat = { v: "Fabrika kabul testi (FAT) isteniyor", src: fat.src };
    const sat = find(docs, TECH, [R(String.raw`(\bSAT\b|[Ss]aha [Kk]abul)`)]);
    if (sat) f.sat = { v: "Saha kabul testi (SAT) isteniyor", src: sat.src };
    put("yedek", find(docs, TECH, [R(String.raw`([^.\f]{0,60}yedek parça[^.\f]{0,140}?\d{1,2}\s*(?:\([^)]{0,12}\)\s*)?(?:yıl|sene)[^.\f]{0,40})`)]), (v) => cut(dropFragment(v), 180));
    const kl = f.miktar && f.miktar.v.match(/(\d+)\s*(?:\([^)]{0,15}\)\s*)?kalem/i);
    if (kl) f.kalemIlan = { v: +kl[1], src: f.miktar.src };
    return f;
  }

  // ---------- Kalem listesi (birim fiyat teklif cetveli, mal listesi, keşif) ----------
  const UNIT = String.raw`(?:adet|ad\.?|takım|tk\.?|set|metre|mt\.?|m|m²|m2|m³|m3|mtül|kg|ton|lt\.?|litre|paket|lisans|kalem|hizmet|ay|gün|saat|km|kişi|adam\/ay|adam\/gün|adam-ay|götürü|gtr\.?|sistem|proje|parti|rulo|kutu|çift|koli|boy|nokta|istasyon|yıl|kVA|kW)`;
  const RX_A = new RegExp(String.raw`^\s*([A-Z]?\d{1,4}(?:[.\-]\d{1,3}){0,2})[.)]?\s+(.{3,240}?)\s+(${UNIT})\s+(\d[\d.,]*)(?=\s|$)`, "iu");
  const RX_B = new RegExp(String.raw`^\s*([A-Z]?\d{1,4})[.)]?\s+(.{3,240}?)\s+(\d[\d.,]*)\s+(${UNIT})(?=\s|$)`, "iu");
  // Kalem adlarındaki teknik ifadeleri düzgün yaz: Türkçe karakter kümesinde olmadığı için "?" olarak kaydedilmiş
  // sembolleri geri getir (η, φ, °, ³, ², ×), birimleri standartlaştır (kW, kVA), parametreleri "Q: 119 m³/h, Hm: 100 mSS" biçiminde ayır.
  const PARAM_KEYS = String.raw`(?:Q|Hm|H|P|N|U|I|n|Sistem verimi \(η\)|Pompa verimi \(η\)|Motor verimi \(η\)|Toplam verim \(η\)|Hidrolik verim \(η\)|Verim|cos φ|Debi|Basma yüksekliği|Güç|Gerilim|Akım|Devir|Çap|DN|PN|IP)`;
  function tidyItemName(name) {
    let s = String(name || "").replace(/�/g, "?").replace(/\s+/g, " ").trim();
    if (!s) return s;
    const VERIM = { sistem: "Sistem verimi", pompa: "Pompa verimi", motor: "Motor verimi", toplam: "Toplam verim", hidrolik: "Hidrolik verim" };
    s = s.replace(/(^|[\s(,;/])(?:\?|η|n|ɳ)\s?(sistem|pompa|motor|toplam|hidrolik)\b/gi, (m, p, w) => `${p}${VERIM[w.toLocaleLowerCase("tr-TR")]} (η)`)
      .replace(/(^|[\s(,;/])\?\s?(verim)\b/gi, "$1Verim (η)")
      .replace(/\bcos\s?[?ϕ]/gi, "cos φ")
      .replace(/(\d)\s?\?\s?C\b/g, "$1 °C").replace(/(\d)\s?º\s?C\b/g, "$1 °C")
      .replace(/\bm\s?[?3]\s?\/\s?(h|sa|saat|s|sn|gün)\b/gi, (m, u) => `m³/${u.toLowerCase()}`)
      .replace(/\b(l|lt)\s?\/\s?(s|sn)\b/gi, "l/s")
      .replace(/(\d)\s?\?\s?(\d)/g, "$1×$2")
      .replace(/(\d+(?:[.,]\d+)?)\s?(kw|KW|Kw)\b/g, "$1 kW").replace(/(\d+(?:[.,]\d+)?)\s?(kva|KVA|Kva)\b/g, "$1 kVA").replace(/(\d+(?:[.,]\d+)?)\s?(kwh|KWH|Kwh|KWh)\b/g, "$1 kWh")
      .replace(/(\d+(?:[.,]\d+)?)\s?(mss|MSS|mSs|mSS)\b/g, "$1 mSS")
      .replace(/%\s?(\d+)[.,]0+\b/g, "%$1").replace(/%\s?(\d+)[.,](\d*[1-9])0*\b/g, "%$1,$2");
    // Parametreler: "Q:119" → "Q: 119"; ardışık parametreler virgülle; ilk parametreden önce ayraç
    const rxKey = new RegExp(`(^|[\\s,;])(${PARAM_KEYS})\\s*[:=]\\s*`, "g");
    s = s.replace(rxKey, (m, p, k) => `${p}${k}: `);
    const rxNext = new RegExp(`\\s+(?=${PARAM_KEYS}: )`, "g");
    let first = true;
    s = s.replace(rxNext, (m, off, all) => {
      const before = all.slice(0, off);
      if (first && !new RegExp(`${PARAM_KEYS}: `).test(before)) { first = false; return /[—–-]\s*$/.test(before) ? " " : " — "; }
      first = false;
      return /[,;]\s*$/.test(before) ? " " : ", ";
    });
    return s.replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim();
  }
  function parseItems(docs) {
    const items = [], seen = new Set();
    const add = (it, d, page) => {
      it.name = tidyItemName(clean(it.name).replace(/^\|\s*|\s*\|$/g, ""));
      if (!it.name || !/\p{L}{3}/u.test(it.name) || !(it.qty > 0) || /^(sıra|toplam|genel toplam|ara toplam|kdv)/i.test(it.name) || /\s[x×]$/i.test(it.name)) return;
      const k = fold(it.no + "|" + it.name + "|" + it.qty);
      if (seen.has(k)) return;
      seen.add(k); items.push({ ...it, src: { name: d.name, type: d.type, page } });
    };
    const pool = docs.filter((d) => d.type === "cetvel");
    const extra = docs.filter((d) => d.type !== "cetvel" && d.type !== "form" && /\bmiktar/i.test(d.text || "") && /\bbirim/i.test(d.text || ""));
    for (const d of pool.concat(extra)) {
      if (d.type !== "cetvel" && items.length) break;   // cetvel bulunduysa diğer belgelerdeki tablolara bakma
      prep(d);
      const before = items.length;
      // 1) Hücreli satırlar (XLSX / DOCX tablosu / PDF sütun boşlukları): başlık satırından sütunları bul
      let hdr = null;
      for (const { t, page } of d._lines) {
        if (/^## /.test(t)) { hdr = null; continue; }
        if (!t.includes(" | ")) continue;
        const cells = t.split(" | ").map((s) => s.trim());
        const f = cells.map(fold);
        const qi = f.findIndex((c) => /^miktar/.test(c));
        const ni = f.findIndex((c) => /aciklama|\badi\b|adı|cinsi|tanim|is kalemi|malzeme|urun|hizmetin|isin|kalem adi/.test(c));
        if (qi >= 0 && ni >= 0 && qi !== ni) {
          hdr = { qi, ni, ui: f.findIndex((c, i) => i !== qi && /^birim(i)?$|olcu birimi|^birimi|^olcu/.test(c)), noi: f.findIndex((c) => /^sira|^no\b|^s\.? ?no|^poz/.test(c)) };
          continue;
        }
        if (hdr && cells.length > Math.max(hdr.qi, hdr.ni)) {
          add({ no: hdr.noi >= 0 ? cells[hdr.noi] || "" : "", name: cells[hdr.ni], unit: hdr.ui >= 0 ? cells[hdr.ui] || "" : "", qty: trNum(cells[hdr.qi]) }, d, page);
        }
      }
      if (items.length > before) continue;
      // 2) Düz metin satırları: "1  SCADA yazılımı  Adet  1,000" / "1 Kablo 250 metre"
      if (d.type !== "cetvel" && !/(birim fiyat|teklif cetveli|mal listesi|keşif özeti|malzeme listesi)/i.test(d.text)) continue;
      for (const { t, page } of d._lines) {
        const line = t.replace(/\s*\|\s*/g, "  ");
        let m = RX_A.exec(line);
        if (m) { add({ no: m[1], name: m[2], unit: m[3], qty: trNum(m[4]) }, d, page); continue; }
        m = RX_B.exec(line);
        if (m) add({ no: m[1], name: m[2], unit: m[4], qty: trNum(m[3]) }, d, page);
      }
    }
    return items;
  }

  // ---------- Teknik analiz ----------
  const DOMAIN = ["SCADA", "RTU", "PLC", "HMI", "DCS", "IEC 61850", "IEC 60870-5-104", "IEC 60870-5-101", "Modbus", "DNP3", "OPC UA", "Profinet", "Profibus",
    "fiber optik", "GPRS", "LTE", "4G", "telemetri", "telekontrol", "uzaktan izleme", "uzaktan kumanda", "veri tabanı", "sunucu", "yedekli", "siber güvenlik",
    "güvenlik duvarı", "UPS", "enerji analizörü", "koruma rölesi", "röle", "trafo merkezi", "dağıtım merkezi", "OG hücre", "kompanzasyon", "akıllı sayaç", "OSOS",
    "pompa", "frekans konvertörü", "sürücü", "debimetre", "seviye sensörü", "basınç", "klor", "ADMS", "OMS", "DMS", "CBS", "GIS", "SIEM", "NTP", "GPS", "switch", "router",
    "kabinet", "pano", "lisans", "yazılım", "entegrasyon", "devreye alma", "bakım", "eğitim"];
  const BRANDS = ["Siemens", "ABB", "Schneider", "General Electric", "GE Vernova", "SEL", "Hitachi", "Emerson", "Honeywell", "Yokogawa", "Rockwell", "Allen-Bradley",
    "AVEVA", "Wonderware", "Ignition", "Inductive Automation", "Phoenix Contact", "Moxa", "Hirschmann", "Cisco", "Mitsubishi", "Omron", "Beckhoff", "WAGO", "Survalent",
    "Eaton", "Legrand", "Janitza", "Entes", "Klemsan", "Weidmüller", "Advantech", "Dell", "HPE", "Lenovo", "Fortinet", "Palo Alto", "Microsoft", "Oracle",
    "Endress+Hauser", "Krohne", "Danfoss", "Grundfos", "Unitronics", "Ruggedcom", "Teltonika", "Huawei", "Kalkitech", "Iconics", "zenon", "COPA-DATA", "WinCC",
    "iFIX", "Proficy", "PcVue", "FactoryTalk", "Citect", "Mikrodev", "Elimko", "Tümsan", "Ventus", "Schweitzer", "Vinci", "Arteche", "Efacec", "NR Electric", "Nari"];
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function countTerm(flatFold, term) {
    const t = fold(term);
    const short = t.replace(/[^a-z0-9]/g, "").length <= 4;
    const rx = new RegExp((short ? String.raw`(?:^|[^a-z0-9])` : String.raw`(?:^|[^a-z0-9])`) + reEsc(t) + (short ? String.raw`(?![a-z0-9])` : ""), "g");
    return (flatFold.match(rx) || []).length;
  }
  function techAnalysis(docs, userKw) {
    const tech = docs.filter((d) => d.type === "teknik");
    const base = tech.length ? tech : docs.filter((d) => ["diger", "cetvel", "idari"].includes(d.type));
    base.forEach(prep);
    const flat = base.map((d) => d._flat).join("\n");
    const ff = fold(flat);
    const terms = [...new Map([...DOMAIN, ...(userKw || [])].map((k) => [fold(k), k])).values()];
    const kw = terms.map((k) => ({ k, n: countTerm(ff, k) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 16);
    const std = new Map();
    for (const m of flat.matchAll(/\b(TS\s?EN|IEC\/EN|IEC|EN|TS|ISO\/IEC|ISO|IEEE|NEMA|DIN|VDE|ANSI|ITU-T)\s?[-]?\s?(\d{2,5}(?:[-–.]\d{1,3}){0,3})(?::\d{4})?\b/g)) {
      if (/^(TS|EN)$/.test(m[1]) && m[2].length < 3) continue;
      const k = (m[1].replace(/\s+/g, " ") + " " + m[2].replace("–", "-")).trim();
      std.set(k, (std.get(k) || 0) + 1);
    }
    const standards = [...std.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, n]) => ({ k, n }));
    const brands = BRANDS.map((b) => {
      const rx = b.length <= 4 ? new RegExp(String.raw`(?:^|[^\p{L}\d])` + reEsc(b) + String.raw`(?![\p{L}\d])`, "gu") : new RegExp(reEsc(b), "giu");
      return { k: b, n: (flat.match(rx) || []).length };
    }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    const muadil = (ff.match(/muadil|esdeger/g) || []).length;
    // Metinde "12 adet RTU" gibi geçen miktarlar
    const qmap = new Map();
    for (const m of flat.matchAll(/(\d{1,4})\s*(?:adet|ad\.|takım|set)\s+([A-ZÇĞİÖŞÜa-zçğıöşü][^\s,.;:()]*(?:\s+[^\s,.;:()|]+){0,4})/g)) {
      const name = clean(m[2]).replace(/\s+(ve|ile|için|olarak|olacak\w*|bulunan|temin|montaj\w*)$/i, "");
      if (name.length < 3 || /^(olarak|ve|ile|için|adet|olmak)$/i.test(name)) continue;
      const k = fold(name) + "|" + m[1];
      if (!qmap.has(k)) qmap.set(k, { qty: +m[1], name });
    }
    const quantities = [...qmap.values()].slice(0, 14);
    // Başlıklar (içindekiler)
    const heads = [], hs = new Set();
    const headOf = (t) => {
      t = t.replace(/\s*\|\s*/g, " ").trim();
      if (t.length > 72 || /\.{4,}|…/.test(t)) return null;
      const m = t.match(/^(\d{1,2}(?:\.\d{1,2})?)[.)]?\s+([A-ZÇĞİÖŞÜ][^.:;!?]{2,68})$/u);
      if (!m || /[,]$/.test(m[2]) || m[2].split(/\s+/).length > 9 || /\d|°|~/.test(m[2])) return null;
      if ((m[2].match(/\(/g) || []).length !== (m[2].match(/\)/g) || []).length) return null;
      const letters = m[2].replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, "");
      const upper = letters === letters.toLocaleUpperCase("tr-TR");
      const title = m[2].split(/\s+/).filter((w) => /^\p{Ll}/u.test(w) && !/^(ve|ile|veya|için|ait|olan|dair|ilişkin|göre)$/.test(w)).length <= 1;
      return letters.length >= 3 && (upper || title) ? { no: m[1], text: m[2].trim() } : null;
    };
    const isSub = (no) => /^\d{1,2}\.[1-9]/.test(no);   // 3.1 alt başlık; 3.0 / 3 ana başlık
    for (const d of tech) {
      let last = 0;
      for (const { t } of d._lines) {
        const h = headOf(t);
        if (!h || h.no.split(".").length > 2) continue;
        const top = parseInt(h.no, 10);
        if (!(top === last || top === last + 1 || (last === 0 && top <= 2))) continue;   // tablo satırlarındaki sayıları ele
        last = top;
        const k = fold(h.text);
        if (hs.has(k)) continue;
        hs.add(k); heads.push(h.no + " " + h.text);
        if (heads.length >= 30) break;
      }
    }
    // Kapsam / işin tanımı bölümü: önce başlık satırını bul, altındaki metni sonraki başlığa kadar al
    let scope = null;
    const SCOPE_HEAD = /^(isin kapsami|proje kapsami|kapsam|amac ve kapsam|konu ve kapsam|isin tanimi|isin konusu)\b/;
    for (const d of tech.length ? tech : base) {
      const L = d._lines;
      for (let i = 0; i < L.length && !scope; i++) {
        const raw = L[i].t.replace(/\s*\|\s*/g, " ").trim();
        const h = headOf(raw) || (/^[A-ZÇĞİÖŞÜ ]{5,40}$/.test(raw) ? { no: "", text: raw } : null);
        if (!h || !SCOPE_HEAD.test(fold(h.text))) continue;
        let buf = "";
        for (let j = i + 1; j < L.length && buf.length < 1500; j++) {
          const u = L[j].t.replace(/\s*\|\s*/g, " ").trim();
          if (buf.length > 60 && headOf(u) && !isSub(headOf(u).no)) break;
          buf += " " + u;
        }
        if (buf.replace(/[^\p{L}]/gu, "").length > 60) scope = { v: sentenceCut(buf, 700), head: h.text, src: { name: d.name, type: d.type, page: d.pages ? L[i].page : null } };
      }
      if (scope) break;
    }
    // Teknik şartnamedeki "İşin Adı" başlığının altındaki satır (idari şartname yoksa iş adı olarak kullanılır)
    let title = null;
    for (const d of tech) {
      const L = d._lines;
      for (let i = 0; i < L.length - 1 && !title; i++) {
        const h = headOf(L[i].t);
        if (h && /^isin adi/.test(fold(h.text)) && L[i + 1].t.trim().length > 5) title = { v: cut(L[i + 1].t.replace(/\s*\|\s*/g, " "), 200), src: { name: d.name, type: d.type, page: d.pages ? L[i].page : null } };
      }
    }
    const rxScope = /(?:^|\s)(?:\d{1,2}(?:\.\d{1,2})?[.)]?\s*)?(İŞİN KAPSAMI|KAPSAM|İŞİN TANIMI|AMAÇ VE KAPSAM|İŞİN KONUSU|KONU|AMAÇ)\s*:?\s+(.{80,1400}?)(?=\s+\d{1,2}(?:\.\d{1,2})*[.)]?\s+[A-ZÇĞİÖŞÜ]{3,}[A-ZÇĞİÖŞÜ ]{3,}|\f|$)/gu;
    if (!scope) outer: for (const d of tech.length ? tech : base) {
      for (const m of d._flat.matchAll(rxScope)) {
        if (/\.{4,}|…{2,}/.test(m[2].slice(0, 200)) || !/^[\p{L}"“(]/u.test(m[2])) continue;   // içindekiler satırı
        scope = { v: sentenceCut(m[2], 700), head: m[1], src: { name: d.name, type: d.type, page: pageAt(d, m.index) } };
        break outer;
      }
    }
    // Öne çıkan zorunlu gereksinim cümleleri
    const domFold = terms.map(fold);
    const reqs = [];
    for (const d of tech) {
      const sents = d._flat.split(/(?<=[.;])\s+(?=[A-ZÇĞİÖŞÜ0-9])/u);
      let off = 0;
      for (const s of sents) {
        const idx = d._flat.indexOf(s, off); off = idx + s.length;
        if (s.length < 40 || s.length > 320) continue;
        if (!/(olmalıdır|olacaktır|edilecektir|zorunludur|sağlanacaktır|mecburidir|gerekmektedir|yapılacaktır|istenmektedir)/.test(s)) continue;
        const sf = fold(s);
        const hits = domFold.filter((k) => sf.includes(k)).length;
        if (!hits) continue;
        reqs.push({ v: clean(s), score: hits + (/\d/.test(s) ? 0.5 : 0), src: { name: d.name, type: d.type, page: pageAt(d, idx) } });
      }
    }
    reqs.sort((a, b) => b.score - a.score);
    const seenR = new Set();
    const requirements = reqs.filter((r) => { const k = fold(r.v).slice(0, 60); if (seenR.has(k)) return false; seenR.add(k); return true; }).slice(0, 10);
    return { kw, standards, brands, muadil, quantities, heads, scope, title, requirements, techDocs: tech.length };
  }

  // ---------- Özet ----------
  function parseTrDate(s) {
    const m = String(s || "").match(/(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 23), +(m[5] || 59)) : null;
  }
  // ---------- Okunamayan kısımlar ----------
  // Metin katmanı olmayan sayfalar: metin PDF'i içinde taranmış ekler, imzalı sayfalar vb.
  function blankPages(f, text) {
    if (f.ext !== "pdf" || !f.pages || f.scanned || f.error) return [];
    const out = [];
    String(text || "").split("\f").forEach((p, i) => { if ((p.match(/\p{L}/gu) || []).length < 25) out.push(i + 1); });
    return out;
  }
  const pageRanges = (arr) => {
    const r = [];
    for (const n of arr) { const last = r[r.length - 1]; if (last && n === last[1] + 1) last[1] = n; else r.push([n, n]); }
    return r.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
  };
  // Kural tabanlı özetin okuyamadığı kısımlar: [{ name, kind, text }]
  function unreadParts(docs) {
    const out = [];
    for (const d of docs) {
      if (d.error) { out.push({ name: d.name, kind: "error", text: `Dosya açılamadı: ${d.error}` }); continue; }
      if (d.scanned) { out.push({ name: d.name, kind: "scanned", text: d.image ? "Resim dosyası (taranmış sayfa); metni okunamadı" : `Tamamı taranmış görüntü${d.pages ? ` (${d.pages} sayfa)` : ""}; metni okunamadı` }); continue; }
      const blank = blankPages(d, d.text);
      if (blank.length) out.push({ name: d.name, kind: "pages", pages: blank, text: `${blank.length === 1 ? "Sayfa" : "Sayfalar"} ${pageRanges(blank)} metin içermiyor (taranmış ya da boş sayfa); bu sayfalardaki bilgiler okunamadı` });
      if (d.truncated) out.push({ name: d.name, kind: "truncated", text: `Doküman çok uzun; ilk ${MAX_TEXT.toLocaleString("tr-TR")} karakter okundu, kalan kısım okunmadı` });
      if (d.approx) out.push({ name: d.name, kind: "approx", text: "Eski Word (.doc) biçimi; metin yaklaşık okundu, tablolar ve biçimli alanlar eksik olabilir (DOCX ya da PDF olarak yüklemek daha güvenilir)" });
    }
    return out;
  }

  function buildSummary(docs, tender, userKw) {
    docs.forEach((d) => { delete d._flat; delete d._lines; });
    const fields = extractFields(docs);
    const items = parseItems(docs);
    const tech = techAnalysis(docs, userKw);
    if (!fields.isAdi && tech.title) fields.isAdi = tech.title;
    const present = new Set(docs.map((d) => d.type));
    const missing = ["idari", "teknik", "cetvel", "sozlesme"].filter((t) => !present.has(t));
    if (missing.includes("cetvel") && items.length) missing.splice(missing.indexOf("cetvel"), 1);
    const scanned = docs.filter((d) => d.scanned && !d.error).map((d) => d.name);
    const failed = docs.filter((d) => d.error).map((d) => ({ name: d.name, error: d.error }));

    const tDate = parseTrDate(fields.tarih?.v) || (tender.tenderDate ? new Date(tender.tenderDate) : null);
    const daysTo = tDate ? Math.ceil((tDate - Date.now()) / 864e5) : null;
    const flags = [];
    const flag = (level, text) => flags.push({ level, text });
    if (daysTo != null && daysTo >= 0) {
      const aGun = fields.aciklamaGun?.v || 10;
      const aDate = new Date(tDate.getTime() - aGun * 864e5);
      if (daysTo <= aGun) flag("warn", `İhaleye ${daysTo} gün kaldı; açıklama talebi süresi (ihaleden ${aGun} gün önce) geçmiş olabilir.`);
      else flag("info", `Açıklama talebi için son gün yaklaşık ${aDate.toLocaleDateString("tr-TR")} (ihaleden ${aGun} gün önce).`);
      if (daysTo <= 7) flag("warn", `Teklif hazırlığı için ${daysTo} gün var.`);
    }
    if (fields.eteklif) flag("info", "Teklif EKAP üzerinden e-teklif olarak verilecek — e-imza ve EKAP kaydı hazır olmalı.");
    if (tech.brands.length && !tech.muadil) flag("warn", `Teknik dokümanda marka adı geçiyor (${tech.brands.slice(0, 4).map((b) => b.k).join(", ")}) ama "muadil/eşdeğer" ifadesi bulunamadı — rekabeti kısıtlayan şartname olabilir, açıklama talebi değerlendir.`);
    else if (tech.brands.length) flag("info", `Markalar: ${tech.brands.slice(0, 5).map((b) => b.k).join(", ")} (muadil ifadesi ${tech.muadil} yerde geçiyor).`);
    const dp = fields.deneyim ? parseFloat(fields.deneyim.v.replace(/[^\d]/g, "")) : null;
    if (dp != null && dp >= 50) flag("warn", `İş deneyim oranı yüksek (${fields.deneyim.v}); referansların yeterli mi kontrol et.`);
    if (fields.fiyatFarki?.v === "Verilmeyecek") flag("info", "Fiyat farkı verilmeyecek — kur/malzeme artışı riskini teklife yansıt.");
    if (fields.kismi?.v === "Verilebilir") flag("info", "Kısmi teklif verilebilir — yalnızca uzmanlık alanındaki kısımlara teklif verme imkânı.");
    if (fields.yerli) flag("info", `Yerli istekli/yerli malı lehine ${fields.yerli.v} uygulanıyor.`);
    if (fields.altYuk && /(yaptırılamaz|verilemez|çalıştırılamaz|izin verilmemektedir)/.test(fields.altYuk.v)) flag("warn", "Alt yüklenici kullanımı kısıtlanmış.");
    if (missing.length) flag("warn", `Bulunamayan doküman: ${missing.map((t) => TYPES[t]).join(", ")}.`);
    // Okunamayan kısımlar ayrı bir uyarı kutusunda gösterilir (taranmış dosyalar, metinsiz sayfalar, açılamayan/kısaltılan dosyalar)
    const unread = unreadParts(docs);

    // Genel özet paragrafı
    const g = [];
    const idare = fields.idare?.v || tender.authority || "";
    const isAdi = fields.isAdi?.v || tender.title || "";
    g.push(`${idare ? idare + " tarafından " : ""}${fields.tur ? fields.tur.v.toLocaleLowerCase("tr-TR") + " kapsamında " : ""}“${isAdi}” ihalesi${fields.usul ? " (" + fields.usul.v + ")" : ""}.`);
    const when = fields.tarih?.v || (tDate ? tDate.toLocaleString("tr-TR", { dateStyle: "long", timeStyle: "short" }) : "");
    if (when) g.push(`İhale tarihi ${when}${fields.eteklif ? ", teklifler EKAP'tan e-teklif olarak verilecek" : ""}.`);
    if (fields.yer) g.push(`İşin yapılacağı/teslim yeri: ${fields.yer.v}.`);
    const sure = fields.sure?.v || fields.teslimSure?.v;
    if (sure) g.push(`Süre: ${cut(sure, 180)}.`);
    if (items.length) {
      const top = items.slice(0, 4).map((i) => `${i.name} (${fmtQty(i.qty)} ${i.unit})`.trim()).join("; ");
      g.push(`Kalem listesinde ${items.length} kalem var${top ? ": " + top + (items.length > 4 ? " …" : "") : ""}.`);
    } else if (fields.kalemIlan) g.push(`İdari şartnameye göre ${fields.kalemIlan.v} kalem.`);
    if (tech.scope) g.push(`Kapsam: ${cut(tech.scope.v, 320)}`);
    else if (fields.miktar) g.push(`Miktar ve tür: ${cut(fields.miktar.v, 240)}`);
    if (tech.kw.length) g.push(`Teknik şartnamede öne çıkanlar: ${tech.kw.slice(0, 6).map((x) => x.k).join(", ")}${tech.standards.length ? "; standartlar: " + tech.standards.slice(0, 5).map((s) => s.k).join(", ") : ""}.`);
    const mali = [fields.deneyim && `iş deneyimi ${fields.deneyim.v}`, fields.gecici && `geçici teminat ${fields.gecici.v}`, fields.sozTuru && fields.sozTuru.v.toLocaleLowerCase("tr-TR"),
      fields.fiyatFarki && `fiyat farkı ${fields.fiyatFarki.v.toLocaleLowerCase("tr-TR")}`, fields.kismi && `kısmi teklif ${fields.kismi.v.toLocaleLowerCase("tr-TR")}`].filter(Boolean);
    if (mali.length) g.push(`Şartlar: ${mali.join(", ")}.`);

    return {
      at: new Date().toISOString(),
      v: SUMMARY_V,
      genel: g.map((s) => (/[.…!?]$/.test(s) ? s : s + ".")).join(" ").replace(/\.\./g, "."),
      fields, items, tech, flags, missing, scanned, failed, unread,
      counts: Object.fromEntries(TYPE_ORDER.map((t) => [t, docs.filter((d) => d.type === t).length]))
    };
  }

  // ---------- Kalıcılık ----------
  const safeName = (s) => fold(s).replace(/[^a-z0-9.\-]+/g, "_").replace(/_+/g, "_").slice(-90);
  function localKey(id) { return "tr.proje." + id; }
  async function loadRecord(ctx) {
    const id = ctx.tender.id;
    if (ctx.cloud) {
      const { data, error } = await ctx.cloud.from("proje_ozet").select("files,texts,summary,ai,updated_at").eq("tender_id", id).maybeSingle();
      if (error) { const e = new Error(error.message); e.missingTable = /proje_ozet|relation|schema cache|does not exist/i.test(error.message); throw e; }
      return data ? { files: data.files || [], texts: data.texts || {}, summary: data.summary, ai: data.ai, updated_at: data.updated_at } : { files: [], texts: {} };
    }
    try { return JSON.parse(localStorage.getItem(localKey(id))) || { files: [], texts: {} }; } catch { return { files: [], texts: {} }; }
  }
  async function saveRecord(ctx, rec) {
    const t = ctx.tender;
    const row = {
      tender_id: t.id,
      tender: { title: t.title, authority: t.authority, ikn: t.ikn || null, tenderDate: t.tenderDate || null, city: t.city || null },
      files: rec.files, texts: rec.texts, summary: rec.summary || null, ai: rec.ai || null, updated_at: new Date().toISOString()
    };
    if (ctx.cloud) {
      row.user_id = ctx.cloud.user.id;
      const { error } = await ctx.cloud.from("proje_ozet").upsert(row, { onConflict: "user_id,tender_id" });
      if (error) throw new Error(error.message);
    } else {
      try { localStorage.setItem(localKey(t.id), JSON.stringify(row)); }
      catch { localStorage.setItem(localKey(t.id), JSON.stringify({ ...row, texts: {} })); }
    }
    ctx.onSaved && ctx.onSaved(t.id, row);
  }

  // ---------- Yapay zekâ özeti (kullanıcının kendi Gemini veya Claude API anahtarıyla) ----------
  const S = (d) => ({ type: "string", description: d });
  const A = (d) => ({ type: "array", items: { type: "string" }, description: d });
  const AI_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["genel_ozet", "kunye", "kapsam", "ana_kalemler", "teknik_gereksinimler", "yeterlik_ve_mali_sartlar", "riskler", "sorulacak_sorular", "eksik_veya_belirsiz", "okunamayan_kisimlar"],
    properties: {
      genel_ozet: S("Projenin 5-8 cümlelik genel özeti: ne alınıyor/yapılıyor, nerede, ne zaman, ölçeği ve öne çıkan özellikleri"),
      kunye: {
        type: "object", additionalProperties: false,
        required: ["idare", "isin_adi", "ihale_turu_usulu", "ihale_tarihi", "yer", "sure", "sozlesme_turu", "kalem_sayisi"],
        properties: {
          idare: S("İdare adı"), isin_adi: S("İşin adı"), ihale_turu_usulu: S("Mal/hizmet/yapım ve ihale usulü"), ihale_tarihi: S("İhale tarihi ve saati"),
          yer: S("İşin yapılacağı / teslim yeri"), sure: S("İşin/teslim süresi"), sozlesme_turu: S("Birim fiyat / götürü bedel vb."), kalem_sayisi: S("Kalem sayısı ve kısa açıklama")
        }
      },
      kapsam: A("İşin kapsamındaki ana iş paketleri, kısa maddeler"),
      ana_kalemler: {
        type: "array", description: "Kalem listesindeki en önemli kalemler (en fazla 15)",
        items: { type: "object", additionalProperties: false, required: ["ad", "miktar", "birim"], properties: { ad: S("Kalem adı"), miktar: S("Miktar"), birim: S("Birim") } }
      },
      teknik_gereksinimler: A("Teklifi doğrudan etkileyen teknik gereksinimler (protokoller, standartlar, donanım/yazılım, test, eğitim, garanti)"),
      yeterlik_ve_mali_sartlar: A("İş deneyimi, benzer iş, teminatlar, fiyat farkı, avans, ceza, ödeme şartları"),
      riskler: A("Teklif veren firma açısından riskler ve dikkat edilmesi gerekenler"),
      sorulacak_sorular: A("İdareye açıklama talebi olarak sorulabilecek belirsizlikler"),
      eksik_veya_belirsiz: A("Dokümanlarda bulunamayan veya çelişkili bilgiler"),
      okunamayan_kisimlar: A("Okuyamadığın ya da emin olamadığın kısımlar: bulanık, kesik, düşük çözünürlüklü, el yazısı, kaşe/imza altında kalan veya boş görünen sayfa/bölümler. Her madde için doküman adı ve sayfa/bölüm belirt. Her şey okunduysa boş liste.")
    }
  };
  const AI_SYSTEM = `Sen, SCADA, otomasyon ve enerji dağıtım projelerine teklif veren bir firmada kıdemli ihale/iş geliştirme uzmanısın.
Sana bir ihalenin dokümanları (idari şartname, teknik şartname, birim fiyat cetveli, sözleşme tasarısı vb.) verilecek.
Görevin, teklif verip vermemeye karar verecek ve teklifi hazırlayacak ekip için tüm dokümanları birlikte değerlendirip Türkçe bir proje özeti çıkarmak.
Yalnızca dokümanlarda yazanlara dayan; bilgi yoksa "Belirtilmemiş" yaz, tahmin etme. Önemli bilginin hangi dokümandan geldiğini gerektiğinde parantez içinde kısaca belirt (ör. "(Teknik Ş. md. 4.2)").
Kısa ve net yaz; maddeler tek cümle olsun.
Taranmış sayfaları da dikkatle oku; okuyamadığın ya da okumasından emin olmadığın her sayfa/bölümü (özellikle rakam, tarih, oran içerenleri) okunamayan_kisimlar alanında açıkça belirt — tahminle doldurma.`;

  // Gönderilecek dokümanlar: metni okunan belgeler metin olarak; taranmış PDF'ler ve resimler dosya olarak (model görsel okur).
  // Yalnızca ihale dokümanları gönderilir; notlar, müşteri kartları vb. asla gönderilmez.
  const VISUAL_MIME = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  async function collectDocs(ctx, rec, mem, opts) {
    const out = [], skipped = [];
    const files = [...rec.files].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
    for (const f of files) {
      if (f.type === "form") continue;
      if (f.error) { skipped.push(`${f.name} — dosya açılamadı (${f.error})`); continue; }
      const label = `${TYPES[f.type]} — ${f.name}`;
      const txt = repairText(rec.texts[f.id]);
      // Tamamı taranmış belgeler ile metinsiz sayfası olan / kısaltılan PDF'ler dosyanın kendisiyle gönderilir (model hem metni hem görüntüyü okur)
      const blank = blankPages(f, txt);
      const needVisual = f.scanned || (f.ext === "pdf" && (blank.length > 0 || f.truncated));
      if (needVisual) {
        const mime = VISUAL_MIME[f.ext];
        let why = !mime ? `${(f.ext || "").toUpperCase()} biçimi okunamıyor; PDF ya da JPG olarak kaydedip yükle` : !opts.accepts(mime, f.size) ? opts.limitText(mime) : null;
        let blob = null;
        if (!why) { blob = mem.get(f.id) || (ctx.cloud && f.storagePath ? await downloadBlob(ctx, f.storagePath) : null); if (!blob) why = "dosya bu cihazda yok; yeniden yükle"; }
        if (!why) { out.push({ kind: "file", label, mime, blob, size: f.size, name: f.name, partial: !f.scanned }); continue; }
        if (f.scanned) { skipped.push(`${f.name} — taranmış belge gönderilemedi (${why})`); continue; }
        skipped.push(`${f.name} — ${blank.length ? `sayfa ${pageRanges(blank)} metin içermiyor` : "dokümanın kısaltılan son kısmı"} ve görsel olarak gönderilemedi (${why}); yalnızca metin kısmı okundu`);
      } else {
        if (f.truncated) skipped.push(`${f.name} — doküman çok uzun; ilk ${MAX_TEXT.toLocaleString("tr-TR")} karakteri okundu, kalan kısım okunmadı`);
        if (f.approx) skipped.push(`${f.name} — eski .doc biçimi; metin yaklaşık okundu, tablolar eksik olabilir`);
      }
      if (txt) out.push({ kind: "text", label, text: txt });
    }
    if (!out.length) throw new Error("Yapay zekâya gönderilecek okunabilir doküman yok" + (skipped.length ? ": " + skipped.join("; ") : ""));
    const chars = out.reduce((a, d) => a + (d.text || "").length, 0);
    if (chars / 3 > 900000) throw new Error("Dokümanlar modelin okuyabileceğinden uzun; gereksiz dosyaları (ekler, formlar) listeden çıkarıp tekrar dene");
    return { docs: out, skipped };
  }
  function aiInstruction(t) {
    return `İhale: ${t.title}\nİdare: ${t.authority}${t.ikn ? "\nİKN: " + t.ikn : ""}${t.tenderDate ? "\nPanelde kayıtlı ihale tarihi: " + new Date(t.tenderDate).toLocaleString("tr-TR") : ""}\n\nYukarıdaki dokümanların tamamını inceleyip proje özetini istenen yapıda hazırla.`;
  }
  // Model şemadaki bazı alanları atlarsa ekranda boş liste göster
  function normalizeAi(o) {
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null && x !== "") : []);
    return {
      genel_ozet: String(o.genel_ozet || ""), kunye: o.kunye && typeof o.kunye === "object" ? o.kunye : {},
      kapsam: arr(o.kapsam), ana_kalemler: arr(o.ana_kalemler).filter((x) => typeof x === "object").map((x) => ({ ...x, ad: tidyItemName(x.ad) })), teknik_gereksinimler: arr(o.teknik_gereksinimler),
      yeterlik_ve_mali_sartlar: arr(o.yeterlik_ve_mali_sartlar), riskler: arr(o.riskler), sorulacak_sorular: arr(o.sorulacak_sorular), eksik_veya_belirsiz: arr(o.eksik_veya_belirsiz), okunamayan_kisimlar: arr(o.okunamayan_kisimlar)
    };
  }
  function parseJsonLoose(txt) {
    const s = String(txt || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(s); } catch { /* aşağıda */ }
    const i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch { /* okunamadı */ } }
    throw new Error("Yapay zekâ yanıtı okunamadı; tekrar dene");
  }

  function runAi(ctx, rec, mem, onProgress) {
    return provider() === "claude" ? runClaude(ctx, rec, mem, onProgress) : runGemini(ctx, rec, mem, onProgress);
  }

  // --- Google Gemini (ücretsiz katman) — REST generateContent, JSON çıktı şemasıyla
  function toGeminiSchema(s) {
    const o = { type: String(s.type).toUpperCase() };
    if (s.description) o.description = s.description;
    if (s.properties) {
      o.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
      o.propertyOrdering = Object.keys(s.properties);
    }
    if (s.required) o.required = s.required;
    if (s.items) o.items = toGeminiSchema(s.items);
    return o;
  }
  async function runGemini(ctx, rec, mem, onProgress) {
    const key = lsGet(PROVIDERS.gemini.keyStore);
    if (!key) throw new Error("Gemini API anahtarı girilmemiş");
    const model = lsGet(GMODEL_STORE) || GEMINI_MODELS[0][0];
    const { docs, skipped } = await collectDocs(ctx, rec, mem, {
      accepts: (mime, size) => size <= 1.9e9, limitText: () => "dosya 2 GB'tan büyük"
    });
    // Küçük görseller isteğe gömülür (toplam ~10 MB); büyükler Gemini dosya servisine yüklenir ve iş bitince silinir
    const GBASE = "https://generativelanguage.googleapis.com";
    const uploaded = [];
    async function uploadFile(d) {
      const fd = new FormData();
      fd.append("metadata", new Blob([JSON.stringify({ file: { display_name: d.name.slice(0, 120) } })], { type: "application/json" }));
      fd.append("file", new Blob([d.blob], { type: d.mime }), d.name);
      const r = await fetch(`${GBASE}/upload/v1beta/files?uploadType=multipart`, { method: "POST", headers: { "x-goog-api-key": key }, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.file) { const e = new Error(`Gemini dosya yükleme ${r.status}: ${(j.error && j.error.message) || r.statusText}`); e.status = r.status; throw e; }
      let file = j.file;
      uploaded.push(file.name);
      for (let i = 0; i < 60 && file.state === "PROCESSING"; i++) {   // büyük PDF'ler birkaç saniye işlenebilir
        await new Promise((res) => setTimeout(res, 2000));
        const g = await fetch(`${GBASE}/v1beta/${file.name}`, { headers: { "x-goog-api-key": key } });
        file = (await g.json().catch(() => null)) || file;
      }
      if (file.state === "FAILED") throw new Error(`${d.name} Gemini tarafından işlenemedi`);
      return file;
    }
    const cleanup = () => uploaded.splice(0).forEach((nm) => fetch(`${GBASE}/v1beta/${nm}`, { method: "DELETE", headers: { "x-goog-api-key": key } }).catch(() => {}));
    const parts = [];
    let inline = 0, visual = 0;
    try {
      for (const d of docs) {
        if (d.kind !== "file") { parts.push({ text: `### ${d.label}\n\n${d.text}` }); continue; }
        visual++;
        parts.push({ text: `### ${d.label} ${d.partial ? "(PDF — bazı sayfaları taranmış; metin ve görüntü sayfalarının tamamını oku)" : "(taranmış belge — görsel olarak oku)"}` });
        if (inline + d.size <= 10e6) { inline += d.size; parts.push({ inline_data: { mime_type: d.mime, data: await blobToBase64(d.blob) } }); }
        else {
          onProgress && onProgress(`Taranmış belge Gemini'ye yükleniyor: ${d.name} (${(d.size / 1048576).toFixed(1)} MB)`);
          const file = await uploadFile(d);
          parts.push({ file_data: { mime_type: file.mimeType || d.mime, file_uri: file.uri } });
        }
      }
    } catch (e) { cleanup(); throw e; }
    parts.push({ text: aiInstruction(ctx.tender) });
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: AI_SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(AI_SCHEMA), maxOutputTokens: 16384 }
    });
    async function call(m) {
      onProgress && onProgress(`Gemini (${m}) dokümanları okuyor… genellikle 20–90 saniye sürer`);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(`Gemini ${r.status} ${(j.error && (j.error.status || "")) || ""}: ${(j.error && j.error.message) || r.statusText}`);
        e.status = r.status; e.provider = "gemini";
        throw e;
      }
      return j;
    }
    let used = null, j = null, lastErr = null;
    try {
      for (const m of [...new Set([model, ...GEMINI_CHAIN])]) {
        try { j = await call(m); used = m; break; }
        catch (e) {
          lastErr = e;
          if (!(e.status === 429 || e.status === 404 || e.status === 500 || e.status === 503)) throw e;   // anahtar/istek hatası: diğer modeller de aynı sonucu verir
        }
      }
    } finally { cleanup(); }
    if (!j) throw lastErr;
    const cand = j.candidates && j.candidates[0];
    if (!cand) throw new Error("Gemini yanıt vermedi" + (j.promptFeedback && j.promptFeedback.blockReason ? ` (engellendi: ${j.promptFeedback.blockReason})` : ""));
    if (cand.finishReason === "MAX_TOKENS") throw new Error("Yanıt uzunluk sınırına takıldı; tekrar dene");
    if (cand.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(cand.finishReason) && !(cand.content && cand.content.parts)) throw new Error(`Gemini yanıtı tamamlamadı (${cand.finishReason})`);
    const txt = ((cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    const u = j.usageMetadata || {};
    return { ...normalizeAi(parseJsonLoose(txt)), provider: "gemini", model: j.modelVersion || used, at: new Date().toISOString(), visual, skipped,
      usage: { input: u.promptTokenCount, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), free: true } };
  }

  // --- Anthropic Claude (ücretli) — resmi SDK, akış + JSON şeması
  async function runClaude(ctx, rec, mem, onProgress) {
    const key = lsGet(PROVIDERS.claude.keyStore);
    if (!key) throw new Error("Claude API anahtarı girilmemiş");
    const { default: Anthropic } = await import(LIB.sdk);
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    // Claude isteği en fazla ~32 MB; resimler tek tek en fazla 5 MB
    let budget = 22e6;
    const { docs, skipped } = await collectDocs(ctx, rec, mem, {
      accepts: (mime, size) => { const ok = mime === "application/pdf" ? size <= budget : size <= 5e6 && size <= budget; if (ok) budget -= size; return ok; },
      limitText: (mime) => (mime === "application/pdf" ? "taranmış PDF'lerin toplamı Claude'un istek sınırını aşıyor" : "resim 5 MB'tan büyük")
    });
    let visual = 0;
    const content = [];
    for (const d of docs) {
      if (d.kind !== "file") { content.push({ type: "text", text: `### ${d.label}\n\n${d.text}` }); continue; }
      visual++;
      const data = await blobToBase64(d.blob);
      content.push(d.mime === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: d.label }
        : { type: "text", text: `### ${d.label} (taranmış belge)` }, ...(d.mime === "application/pdf" ? [] : [{ type: "image", source: { type: "base64", media_type: d.mime, data } }]));
    }
    content.push({ type: "text", text: aiInstruction(ctx.tender) });
    onProgress && onProgress("Claude dokümanları okuyor…");

    const stream = client.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: AI_SCHEMA } },
      system: AI_SYSTEM,
      messages: [{ role: "user", content }]
    });
    let chars = 0;
    stream.on("text", (d) => { chars += d.length; onProgress && onProgress(`Yapay zekâ yazıyor… ${chars.toLocaleString("tr-TR")} karakter`); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Model bu isteği yanıtlamadı (refusal)");
    if (msg.stop_reason === "max_tokens") throw new Error("Yanıt uzunluk sınırına takıldı; tekrar dene");
    const txt = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const u = msg.usage || {};
    const cost = ((u.input_tokens || 0) * 4 + (u.output_tokens || 0) * 20) / 1e6;
    return { ...normalizeAi(parseJsonLoose(txt)), provider: "claude", model: msg.model, at: new Date().toISOString(), visual, skipped,
      usage: { input: u.input_tokens, output: u.output_tokens, costUsd: Math.round(cost * 100) / 100 } };
  }
  // Word raporu (rapor.js) ve Bid/No-Bid sunumu (sunum.js) modülleri ilk kullanımda, proje.js ile aynı sürümden yüklenir
  const modLoads = {};
  function loadModule(file, globalName) {
    if (window[globalName]) return Promise.resolve();
    return modLoads[file] || (modLoads[file] = new Promise((res, rej) => {
      const me = [...document.scripts].find((x) => /proje\.js/.test(x.src));
      const s = document.createElement("script");
      s.src = me ? me.src.replace(/proje\.js/, file) : "assets/js/" + file;
      s.onload = res; s.onerror = () => { delete modLoads[file]; rej(new Error(file + " yüklenemedi")); };
      document.head.appendChild(s);
    }));
  }
  const loadReportLib = () => loadModule("rapor.js", "TR_RAPOR");
  function aiErrorText(pv, err) {
    const m = String((err && err.message) || err);
    const s = err && err.status;
    if (pv === "gemini") {
      if (/API_KEY_INVALID|API key not valid|API key expired/i.test(m) || s === 401) return "Gemini anahtarı geçersiz. Anahtarı silip aistudio.google.com'dan aldığın anahtarı yeniden gir.";
      if (s === 429 || /RESOURCE_EXHAUSTED|quota/i.test(m)) return "Gemini ücretsiz kotası doldu (dakikalık ya da günlük sınır). Bir dakika sonra tekrar dene; günlük sınır dolduysa yarın sıfırlanır. Doküman çok büyükse gereksiz dosyaları listeden çıkarmak da yardımcı olur.";
      if (/location is not supported|not available in your country/i.test(m)) return "Gemini API bulunduğun bölgede ücretsiz olarak sunulmuyor.";
      if (s === 403) return "Bu anahtarın Gemini API'ye erişim izni yok (Google AI Studio'da anahtarın projesini kontrol et).";
      if (s === 404) return "Seçili Gemini modeli bulunamadı; listeden başka bir model seçip tekrar dene.";
      if (s >= 500) return "Gemini modellerinin hepsi şu an yoğun ya da Google tarafında geçici bir sorun var; birkaç dakika sonra tekrar dene.";
      if (/Failed to fetch|NetworkError/i.test(m)) return "Google'a bağlanılamadı; internet bağlantını kontrol et.";
      return "Gemini özeti oluşturulamadı: " + m;
    }
    if (s === 401 || /authentication|invalid x-api-key/i.test(m)) return "Claude anahtarı geçersiz. Anahtarı silip yeniden gir.";
    if (s === 429 || /rate/i.test(m)) return "Hız sınırına takıldı; bir dakika sonra tekrar dene.";
    if (/credit|billing|balance/i.test(m)) return "Anthropic hesabında kredi yok; console.anthropic.com → Billing.";
    return "Claude özeti oluşturulamadı: " + m;
  }
  function blobToBase64(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function downloadBlob(ctx, path) {
    const { data, error } = await ctx.cloud.storage(BUCKET).download(path);
    if (error) return null;
    return data;
  }

  // ---------- Arayüz ----------
  function srcChip(src) {
    if (!src) return "";
    const short = { idari: "İdari Ş.", teknik: "Teknik Ş.", cetvel: "Cetvel", sozlesme: "Sözleşme", ilan: "İlan", zeyil: "Zeyilname", form: "Form", diger: "Doküman" }[src.type] || "Doküman";
    return `<span class="src-chip" title="${esc(src.name)}${src.page ? " · sayfa " + src.page : ""}">${short}${src.page ? " s." + src.page : ""}</span>`;
  }
  const kvRow = (label, f, fallback) => (f || fallback) ? `<dt>${label}</dt><dd>${f ? esc(f.v) + " " + srcChip(f.src) : `<span class="muted">${esc(fallback)}</span>`}</dd>` : "";
  // Metin içindeki doküman atıflarını, ör. "(Özel Teknik Ş. md. 1.9)", "(İdari Şartname, s. 4)", hafif renkle ayır
  const RX_CITE = /\((?=[^()]{2,140}\))[^()]*?(?:Ş\.|[Şş]artname|[Ss]özleşme|[Cc]etvel|İlan|[Zz]eyilname|[Tt]asar|\bmd\.|[Mm]adde|\bs\.\s?\d|[Ss]ayfa|\bEk[- ]?\d|[Kk]alem\s?\d)[^()]*\)/g;
  const citeHtml = (s) => esc(s).replace(RX_CITE, (m) => `<span class="cite">${m}</span>`);
  // Okunamayan kısımlar uyarı kutusu: rows = [[dosya adı, açıklama], …]
  function unreadBox(title, rows, note) {
    return `<div class="unread-box" role="alert"><b>⚠ ${esc(title)}</b>
      <ul>${rows.map(([n, d]) => `<li>${n ? `<span class="unread-file">${esc(n)}</span> — ` : ""}${esc(d)}</li>`).join("")}</ul>
      ${note ? `<p>${note}</p>` : ""}</div>`;
  }
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

  function mount(root, ctx) {
    const st = { rec: null, busy: "", error: null, mem: new Map(), showAllItems: false, aiErr: null };
    const t = ctx.tender;

    async function init() {
      root.innerHTML = `<p class="muted">Proje kaydı yükleniyor…</p>`;
      try { st.rec = await loadRecord(ctx); }
      catch (e) {
        root.innerHTML = e.missingTable
          ? `<div class="card card-pad"><h3>Kurulum gerekiyor</h3><p class="small">Proje özetleri için Supabase'de <code>supabase/guncelleme-4.sql</code> dosyasının bir kez çalıştırılması gerekiyor
             (Supabase → SQL Editor → New query → dosya içeriğini yapıştır → Run). Sonra bu sayfayı yenile.</p></div>`
          : `<div class="card card-pad"><p>Kayıt yüklenemedi: ${esc(e.message)}</p></div>`;
        return;
      }
      // Özet eski bir sürümle çıkarıldıysa dokümanları yeni okuyucularla tazele ve özeti yeniden hesapla
      if (st.rec.files.length && (!st.rec.summary || st.rec.summary.v !== SUMMARY_V)) {
        root.innerHTML = `<p class="muted">Dokümanlar güncel okuyucuyla yeniden işleniyor…</p>`;
        try {
          await refreshTexts((m) => { const p = root.querySelector("p"); if (p) p.textContent = m; });
          recompute();
          await saveRecord(ctx, st.rec);
        } catch (e) { st.error = "Dokümanlar yeniden işlenemedi: " + (e.message || e); }
      }
      draw();
    }

    function draw() {
      const rec = st.rec;
      const s = rec.summary;
      root.innerHTML = `
        ${s ? `<div class="report-bar">
          <div><b>Rapor ve sunum</b> <span class="muted small">hazırlayan Muhammet Emin Gülay · ${new Date().toLocaleDateString("tr-TR")}${rec.ai ? " · yapay zekâ özeti dahil" : ""}</span></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary" data-p="word" type="button" ${st.busy ? "disabled" : ""} title="Detaylı İhale Özet Raporu (Word)">📄 Word raporu indir</button>
            <button class="btn primary" data-p="pptx" type="button" ${st.busy ? "disabled" : ""} title="Yönetici için 4 sayfalık sade sunum: ihale adı ve tarihi, kapsam, finansal riskler, proje riskleri">📊 Bid/No-Bid sunumu indir</button>
          </div>
        </div>` : ""}
        <div class="card card-pad proje-docs">
          <div class="proje-docs-head">
            <h3 style="margin:0">Dokümanlar <span class="muted small">${rec.files.length || ""}</span></h3>
            ${rec.files.length ? `<button class="btn small" data-p="reanalyze" type="button" ${st.busy ? "disabled" : ""}>↻ Yeniden analiz et</button>` : ""}
          </div>
          <label class="dropzone ${st.busy ? "busy" : ""}" id="pDrop">
            <input type="file" id="pFile" multiple accept=".zip,.pdf,.docx,.doc,.xlsx,.xls,.xlsm,.ods,.csv,.txt,.htm,.html,.jpg,.jpeg,.png,.webp,.tif,.tiff" hidden ${st.busy ? "disabled" : ""}>
            <b>${st.busy ? esc(st.busy) : "Dokümanları buraya sürükle ya da tıklayıp seç"}</b>
            <span class="muted small">${st.busy ? "" : "EKAP'tan indirdiğin ZIP'i olduğu gibi bırakabilirsin; PDF, Word, Excel ve taranmış sayfa resimleri (JPG, PNG) de olur. İdari + teknik şartname + birim fiyat cetveli + sözleşme tasarısı birlikte en iyi sonucu verir."}</span>
          </label>
          ${t.ekapUrl ? `<p class="muted small" style="margin:8px 0 0">EKAP'ta: <a href="${esc(t.ekapUrl)}" target="_blank" rel="noopener">ihaleyi aç ↗</a> → <b>İhale Dokümanı</b> → indir (e-imza/EKAP girişi gerekebilir) → indirilen ZIP'i buraya bırak.</p>` : ""}
          ${st.error ? `<p class="small" style="color:var(--urgent);margin:8px 0 0">${esc(st.error)}</p>` : ""}
          ${rec.files.length ? `<div class="table-wrap" style="margin-top:12px"><table class="table small">
            <thead><tr><th>Dosya</th><th>Tür</th><th>Sayfa</th><th>Metin</th><th></th></tr></thead>
            <tbody>${rec.files.map((f) => `<tr>
              <td>${f.storagePath && ctx.cloud ? `<a href="#" data-p="open" data-id="${esc(f.id)}">${esc(f.name)}</a>` : esc(f.name)}${f.path !== f.name ? `<div class="muted" style="font-size:11px">${esc(f.path)}</div>` : ""}</td>
              <td><select data-ptype="${esc(f.id)}">${TYPE_ORDER.map((k) => `<option value="${k}" ${f.type === k ? "selected" : ""}>${TYPES[k]}</option>`).join("")}</select></td>
              <td>${f.pages || "—"}</td>
              <td>${f.error ? `<span style="color:var(--urgent)" title="${esc(f.error)}">okunamadı</span>` : f.scanned ? `<span style="color:var(--week)" title="Metin katmanı yok (taranmış görüntü)">taranmış</span>` : `${(f.chars || 0) < 1000 ? (f.chars || 0) + " kr." : Math.round(f.chars / 1000) + "k kr."}${(() => { const b = blankPages(f, rec.texts[f.id]); return b.length ? ` <span style="color:var(--week)" title="Bu sayfalarda metin yok (taranmış ya da boş)">· s. ${pageRanges(b)} okunamadı</span>` : ""; })()}${f.truncated ? ` <span style="color:var(--week)">(kısaltıldı)</span>` : ""}${f.approx ? ` <span style="color:var(--week)" title="Eski .doc biçimi, yaklaşık okundu">~ yaklaşık</span>` : ""}`}</td>
              <td><button class="btn ghost small" data-p="del" data-id="${esc(f.id)}" title="Dosyayı kaldır" type="button">✕</button></td></tr>`).join("")}</tbody></table></div>` : ""}
        </div>
        ${s ? summaryHtml(s) : rec.files.length ? "" : `<div class="card card-pad"><p class="muted" style="margin:0">Dokümanları yükleyince ihale künyesi, kapsam, kalem listesi, teknik öne çıkanlar, yeterlik/mali şartlar ve dikkat edilecekler burada oluşur.</p></div>`}
        ${rec.files.length ? aiHtml() : ""}`;
    }

    function summaryHtml(s) {
      const f = s.fields, tech = s.tech, items = s.items || [];
      const shown = st.showAllItems ? items : items.slice(0, 15);
      return `
        <div class="card card-pad proje-sum">
          <div class="proje-docs-head"><h3 style="margin:0">Proje özeti</h3>
            <div style="display:flex;gap:6px"><button class="btn small" data-p="copy" type="button">⧉ Kopyala</button><button class="btn small" data-p="print" type="button">🖨 Yazdır</button></div></div>
          ${(() => {
            const unread = s.unread || unreadParts(st.rec.files.map((x) => ({ ...x, text: st.rec.texts[x.id] || "" })));
            return unread.length ? unreadBox("Okunamayan kısımlar — bu özete dahil edilmedi", unread.map((u) => [u.name, u.text]),
              unread.some((u) => ["scanned", "pages", "truncated"].includes(u.kind)) ? `Taranmış belgeleri ve metin içermeyen sayfaları aşağıdaki <b>Yapay zekâ ile detaylı özet</b> görsel olarak okur.` : "") : "";
          })()}
          <div class="summary-box" style="margin-top:10px"><b>Genel özet</b>${esc(s.genel)}</div>
          ${s.flags.length ? `<ul class="flag-list">${s.flags.map((x) => `<li class="${x.level}">${esc(x.text)}</li>`).join("")}</ul>` : ""}
          <div class="proje-grid">
            <section><h4>Künye</h4><dl class="kv">
              ${kvRow("İdare", f.idare, t.authority)}
              ${kvRow("İşin adı", f.isAdi, t.title)}
              ${kvRow("Tür", f.tur)}
              ${kvRow("Usul", f.usul)}
              ${kvRow("İhale tarihi", f.tarih, t.tenderDate ? new Date(t.tenderDate).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" }) + " (ilandan)" : "")}
              ${kvRow("Teklif", f.eteklif)}
              ${kvRow("Teslim / iş yeri", f.yer, t.city || "")}
              ${kvRow("Süre", f.sure || f.teslimSure)}
              ${kvRow("Sözleşme türü", f.sozTuru)}
              ${kvRow("Kısmi teklif", f.kismi)}
              ${kvRow("Miktar ve tür", f.miktar)}
              ${t.ikn ? `<dt>İKN</dt><dd>${esc(t.ikn)}</dd>` : ""}
            </dl></section>
            <section><h4>Yeterlik ve mali şartlar</h4><dl class="kv">
              ${kvRow("İş deneyimi", f.deneyim)}
              ${kvRow("Benzer iş", f.benzerIs)}
              ${kvRow("Geçici teminat", f.gecici)}
              ${kvRow("Kesin teminat", f.kesin)}
              ${kvRow("Fiyat farkı", f.fiyatFarki)}
              ${kvRow("Avans", f.avans)}
              ${kvRow("Yerli avantajı", f.yerli)}
              ${kvRow("Sınır değer (N)", f.sinir)}
              ${kvRow("Teklif geçerliliği", f.gecerlilik)}
              ${kvRow("Gecikme cezası", f.ceza)}
              ${kvRow("Alt yüklenici", f.altYuk)}
            </dl>${["deneyim", "gecici", "fiyatFarki", "benzerIs"].some((k) => f[k]) ? "" : `<p class="muted small">İdari şartname yüklenmediği ya da okunamadığı için bu alanlar boş.</p>`}</section>
          </div>
          <section style="margin-top:18px"><h4>Kapsam ${tech.scope ? srcChip(tech.scope.src) : ""}</h4>
            ${tech.scope ? `<p class="small" style="margin:0 0 10px;line-height:1.6">${esc(tech.scope.v)}</p>` : `<p class="muted small">Teknik şartnamede kapsam bölümü bulunamadı.</p>`}
            ${tech.heads.length ? `<details><summary class="small">Teknik şartname başlıkları (${tech.heads.length})</summary><ol class="small heads">${tech.heads.map((h) => `<li>${esc(h)}</li>`).join("")}</ol></details>` : ""}
          </section>
          <section style="margin-top:18px"><h4>Kalem listesi ${items.length ? `<span class="muted small">${items.length} kalem</span>` : ""}</h4>
            ${items.length ? `<div class="table-wrap"><table class="table small"><thead><tr><th>No</th><th>Kalem</th><th style="text-align:right">Miktar</th><th>Birim</th></tr></thead><tbody>
              ${shown.map((i) => `<tr><td>${esc(i.no)}</td><td>${esc(i.name)}</td><td style="text-align:right">${esc(fmtQty(i.qty))}</td><td>${esc(i.unit)}</td></tr>`).join("")}</tbody></table></div>
              ${items.length > 15 ? `<button class="btn ghost small" data-p="items" type="button">${st.showAllItems ? "Daha az göster" : `Tüm ${items.length} kalemi göster`}</button>` : ""}`
              : `<p class="muted small">${f.kalemIlan ? `İdari şartnameye göre ${esc(f.kalemIlan.v)} kalem; ` : ""}birim fiyat teklif cetveli / mal listesi yüklenmedi ya da tablo okunamadı.</p>`}
            ${tech.quantities.length ? `<p class="small" style="margin:10px 0 4px"><b>Metinde geçen miktarlar:</b></p><div class="chip-row">${tech.quantities.map((q) => `<span class="tag">${esc(q.qty)} × ${esc(q.name)}</span>`).join("")}</div>` : ""}
          </section>
          <section style="margin-top:18px"><h4>Teknik öne çıkanlar ${tech.techDocs ? "" : `<span class="muted small">(teknik şartname yok — diğer dokümanlardan)</span>`}</h4>
            ${tech.kw.length ? `<div class="chip-row">${tech.kw.map((x) => `<span class="tag">${esc(x.k)} <b>${x.n}</b></span>`).join("")}</div>` : `<p class="muted small">Alan anahtar kelimesi bulunamadı.</p>`}
            ${tech.standards.length ? `<p class="small" style="margin:10px 0 4px"><b>Standartlar:</b> ${tech.standards.map((x) => esc(x.k)).join(", ")}</p>` : ""}
            ${tech.brands.length ? `<p class="small" style="margin:6px 0 4px"><b>Markalar:</b> ${tech.brands.map((x) => `${esc(x.k)} (${x.n})`).join(", ")} · muadil/eşdeğer ifadesi: ${tech.muadil}</p>` : ""}
            <dl class="kv" style="margin-top:8px">
              ${kvRow("Garanti", f.garanti)}${kvRow("Eğitim", f.egitim)}${kvRow("Testler", f.fat || f.sat ? { v: [f.fat && "FAT", f.sat && "SAT"].filter(Boolean).join(" + "), src: (f.fat || f.sat).src } : null)}${kvRow("Yedek parça", f.yedek)}
            </dl>
            ${tech.requirements.length ? `<details open><summary class="small">Öne çıkan gereksinimler</summary><ul class="small reqs">${tech.requirements.map((r) => `<li>${esc(r.v)} ${srcChip(r.src)}</li>`).join("")}</ul></details>` : ""}
          </section>
          <p class="muted small" style="margin:14px 0 0">Kural tabanlı otomatik çıkarım — ${new Date(s.at).toLocaleString("tr-TR")}. Rakamları teklif öncesinde dokümandan teyit et; kaynak etiketinin üzerine gelince dosya adı ve sayfa görünür.</p>
        </div>`;
    }

    function aiHtml() {
      const ai = st.rec.ai;
      const pv = provider(), P = PROVIDERS[pv];
      const hasKey = !!lsGet(P.keyStore);
      const chars = st.rec.files.filter((f) => f.type !== "form").reduce((a, f) => a + (st.rec.texts[f.id] || "").length, 0);
      const estIn = Math.round(chars / 3);
      const estCost = (estIn * 4 + 6000 * 20) / 1e6;
      const gModel = lsGet(GMODEL_STORE) || GEMINI_MODELS[0][0];
      const L = (title, arr) => arr && arr.length ? `<section><h4>${title}</h4><ul class="small">${arr.map((x) => `<li>${citeHtml(x)}</li>`).join("")}</ul></section>` : "";
      const info = pv === "gemini"
        ? `Tüm dokümanlar birlikte okunur (≈ ${estIn.toLocaleString("tr-TR")} token) — Google'ın <b>ücretsiz kotasıyla</b> çalışır. Taranmış PDF'ler görsel olarak okunur.
           <br><span class="muted">Ücretsiz katmanda Google gönderilen içeriği ürünlerini geliştirmek için kullanabilir; bu yüzden yalnızca ihale dokümanları gönderilir — notların, fiyatların ve müşteri kartların gönderilmez.</span>`
        : `Tüm dokümanlar birlikte okunur (≈ ${estIn.toLocaleString("tr-TR")} token, tahmini maliyet ≈ $${estCost.toFixed(2)}). Taranmış PDF'ler görsel olarak okunur.`;
      return `
        <div class="card card-pad" id="aiCard">
          <div class="proje-docs-head"><h3 style="margin:0">Yapay zekâ ile detaylı özet</h3>
            <div class="prov-switch" role="group" aria-label="Yapay zekâ sağlayıcısı">
              ${Object.entries(PROVIDERS).map(([k, p]) => `<button class="btn small ${k === pv ? "on" : "ghost"}" data-p="prov" data-v="${k}" type="button" ${st.busy ? "disabled" : ""}>${p.label} <span class="muted">(${p.note})</span>${lsGet(p.keyStore) ? " ✓" : ""}</button>`).join("")}
            </div></div>
          ${hasKey ? `
            <div class="ai-run">
              ${pv === "gemini" ? `<label class="small">Model <select data-pmodel>${GEMINI_MODELS.map(([v, l]) => `<option value="${v}" ${v === gModel ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : `<span class="small">Model: ${CLAUDE_MODEL}</span>`}
              <button class="btn small ${ai ? "" : "primary"}" data-p="ai" type="button" ${st.busy ? "disabled" : ""}>${ai ? `↻ ${P.label} ile yeniden oluştur` : `🤖 ${P.label} ile özet oluştur`}</button>
            </div>
            <p class="muted small ai-status" style="margin:6px 0 0">${info} <a href="#" data-p="key-clear">${P.label} anahtarını bu cihazdan sil</a></p>`
          : `<p class="small" style="margin:8px 0 8px">Kural tabanlı özete ek olarak dokümanları okuyup yorumlayan bir özet (kapsam, riskler, açıklama talebi soruları) için <b>${P.label} API anahtarını</b> gir.
               Anahtarı <a href="${P.keyUrl}" target="_blank" rel="noopener">${P.keySite}</a> adresinden alabilirsin${pv === "gemini" ? " (Google hesabıyla, kredi kartı gerekmez)" : " (kullandıkça ücretlendirilir)"}.
               Anahtar yalnızca bu tarayıcıda saklanır, sunucuya/veritabanına yazılmaz — her cihazda bir kez girmen gerekir.</p>
             <form class="kw-add" data-pform="key"><input type="hidden" name="prov" value="${pv}"><input class="input" name="key" type="password" autocomplete="off" placeholder="${P.keyHint}" style="flex:1"><button class="btn primary" type="submit">Kaydet</button></form>`}
          ${st.aiErr ? `<p class="small" style="color:var(--urgent);margin:8px 0 0">${esc(st.aiErr)}</p>` : ""}
          ${ai ? `
            ${(() => {
              const rows = [...(ai.skipped || []).map((x) => { const i = x.indexOf(" — "); return i > 0 ? [x.slice(0, i), x.slice(i + 3)] : ["", x]; }),
                ...(ai.okunamayan_kisimlar || []).map((x) => ["", x])];
              const changed = st.rec.files.some((f) => !(ai.fileIds || []).includes(f.id)) && ai.fileIds;
              return (rows.length ? unreadBox("Okunamayan veya okunmasından emin olunamayan kısımlar", rows, "Bu kısımlardaki bilgiler özete yansımamış olabilir; ilgili sayfaları dokümandan kontrol et.") :
                `<p class="small ok-line">✓ Gönderilen dokümanların tamamı okundu${ai.visual ? ` (${ai.visual} taranmış belge görsel olarak okundu)` : ""}.</p>`) +
                (changed ? `<p class="small" style="color:var(--week);margin:6px 0 0">Bu özet oluşturulduktan sonra doküman eklendi/çıkarıldı; güncel olması için yeniden oluştur.</p>` : "");
            })()}
            <div class="summary-box" style="margin-top:12px"><b>Genel özet</b>${citeHtml(ai.genel_ozet)}</div>
            <div class="proje-grid">
              <section><h4>Künye</h4><dl class="kv">${Object.entries({ idare: "İdare", isin_adi: "İşin adı", ihale_turu_usulu: "Tür / usul", ihale_tarihi: "İhale tarihi", yer: "Yer", sure: "Süre", sozlesme_turu: "Sözleşme türü", kalem_sayisi: "Kalemler" })
                .map(([k, l]) => ai.kunye && ai.kunye[k] ? `<dt>${l}</dt><dd>${citeHtml(ai.kunye[k])}</dd>` : "").join("")}</dl></section>
              ${L("Kapsam", ai.kapsam)}
            </div>
            ${ai.ana_kalemler && ai.ana_kalemler.length ? `<section style="margin-top:12px"><h4>Ana kalemler</h4><div class="table-wrap"><table class="table small"><thead><tr><th>Kalem</th><th style="text-align:right">Miktar</th><th>Birim</th></tr></thead><tbody>
              ${ai.ana_kalemler.map((i) => `<tr><td>${citeHtml(tidyItemName(i.ad))}</td><td style="text-align:right">${esc(i.miktar)}</td><td>${esc(i.birim)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
            <div class="proje-grid" style="margin-top:12px">
              ${L("Teknik gereksinimler", ai.teknik_gereksinimler)}
              ${L("Yeterlik ve mali şartlar", ai.yeterlik_ve_mali_sartlar)}
              ${L("Riskler / dikkat", ai.riskler)}
              ${L("Açıklama talebi için sorular", ai.sorulacak_sorular)}
              ${L("Eksik veya belirsiz", ai.eksik_veya_belirsiz)}
            </div>
            <p class="muted small" style="margin:10px 0 0">${esc(PROVIDERS[ai.provider || "claude"]?.label || "")} · ${esc(ai.model || "")} · ${new Date(ai.at).toLocaleString("tr-TR")}${ai.usage ? ` · ${(ai.usage.input || 0).toLocaleString("tr-TR")} + ${(ai.usage.output || 0).toLocaleString("tr-TR")} token${ai.usage.free ? " (ücretsiz kota)" : ai.usage.costUsd != null ? ` ≈ $${ai.usage.costUsd}` : ""}` : ""}. Yapay zekâ hata yapabilir; kritik bilgileri dokümandan teyit et.</p>` : ""}
        </div>`;
    }

    function summaryText() {
      const s = st.rec.summary; if (!s) return "";
      const f = s.fields, L = [];
      L.push(`PROJE ÖZETİ — ${t.title}`, `${t.authority}${t.ikn ? " · İKN " + t.ikn : ""}`, "", s.genel, "");
      const kv = [["İhale tarihi", f.tarih], ["Tür", f.tur], ["Usul", f.usul], ["Yer", f.yer], ["Süre", f.sure || f.teslimSure], ["Sözleşme türü", f.sozTuru], ["Kısmi teklif", f.kismi],
        ["İş deneyimi", f.deneyim], ["Benzer iş", f.benzerIs], ["Geçici teminat", f.gecici], ["Fiyat farkı", f.fiyatFarki], ["Avans", f.avans], ["Gecikme cezası", f.ceza], ["Garanti", f.garanti]];
      kv.forEach(([k, v]) => v && L.push(`${k}: ${v.v}`));
      if (s.items.length) { L.push("", `Kalemler (${s.items.length}):`); s.items.slice(0, 30).forEach((i) => L.push(`- ${i.name} — ${fmtQty(i.qty)} ${i.unit}`)); }
      if (s.flags.length) { L.push("", "Dikkat:"); s.flags.forEach((x) => L.push("- " + x.text)); }
      const ai = st.rec.ai;
      if (ai) {
        L.push("", "YAPAY ZEKÂ ÖZETİ", ai.genel_ozet);
        [["Kapsam", ai.kapsam], ["Teknik gereksinimler", ai.teknik_gereksinimler], ["Riskler", ai.riskler], ["Sorular", ai.sorulacak_sorular]].forEach(([k, a]) => { if (a && a.length) { L.push("", k + ":"); a.forEach((x) => L.push("- " + x)); } });
      }
      return L.join("\n");
    }

    function recompute() {
      const docs = st.rec.files.map((f) => ({ ...f, text: st.rec.texts[f.id] || "" }));
      st.rec.summary = buildSummary(docs, t, ctx.keywords);
    }

    // Eski okuyucuyla okunmuş Word/HTML türü dosyaları asıllarından yeniden oku; asıl yoksa kayıtlı metni onar
    async function refreshTexts(setMsg) {
      let changed = 0;
      for (const f of st.rec.files) {
        const old = st.rec.texts[f.id] || "";
        const reread = !f.error && ["doc", "htm", "html", "rtf", "mht", "mhtml", "xml", "txt"].includes(f.ext) || (f.approx && !f.error);
        let done = false;
        if (reread) {
          const blob = st.mem.get(f.id) || (ctx.cloud && f.storagePath ? await downloadBlob(ctx, f.storagePath) : null);
          if (blob) {
            setMsg && setMsg(`Yeniden okunuyor: ${f.name}`);
            const [d] = await extractFiles([new File([blob], f.name)]);
            if (d && !d.error && d.text) {
              if (d.text !== old) changed++;
              st.rec.texts[f.id] = d.text;
              Object.assign(f, { chars: d.chars, approx: d.approx || false, truncated: d.truncated || false, scanned: d.scanned || false, pages: d.pages });
              done = true;
            }
          }
        }
        if (!done) { const fixed = repairText(old); if (fixed !== old) { st.rec.texts[f.id] = fixed; f.chars = fixed.length; changed++; } }
      }
      return changed;
    }

    async function addFiles(list) {
      if (!list.length || st.busy) return;
      st.error = null;
      const setBusy = (m) => { st.busy = m; const b = root.querySelector("#pDrop b"); if (b) b.textContent = m; };
      setBusy("Dosyalar okunuyor…"); draw();
      try {
        const docs = await extractFiles([...list], setBusy);
        // Aynı ad + boyuttaki eski kayıtların yerine geçer
        for (const d of docs) {
          const old = st.rec.files.find((f) => f.name === d.name && f.size === d.size);
          if (old) { st.rec.files = st.rec.files.filter((f) => f !== old); delete st.rec.texts[old.id]; }
          if (ctx.cloud && d.size <= MAX_UPLOAD) {
            setBusy(`Yükleniyor: ${d.name}`);
            const path = `${ctx.cloud.user.id}/${safeName(t.id)}/${d.id}-${safeName(d.name)}`;
            const { error } = await ctx.cloud.storage(BUCKET).upload(path, d.blob, { upsert: true, contentType: d.blob.type || "application/octet-stream" });
            if (!error) d.storagePath = path;
            else st.error = `Bazı dosyalar depoya yüklenemedi (${error.message}); özet yine de oluşturuldu.`;
          }
          st.mem.set(d.id, d.blob);
          st.rec.texts[d.id] = d.text;
          const { blob, text, _flat, _lines, ...meta } = d;
          st.rec.files.push(meta);
        }
        st.rec.files.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
        setBusy("Analiz ediliyor…");
        recompute();
        setBusy("Kaydediliyor…");
        await saveRecord(ctx, st.rec);
        ctx.toast && ctx.toast(`${docs.length} doküman işlendi — proje özeti hazır`);
      } catch (e) { st.error = "İşlem tamamlanamadı: " + (e.message || e); }
      st.busy = ""; draw();
    }

    async function persist(msg) {
      try { await saveRecord(ctx, st.rec); if (msg) ctx.toast && ctx.toast(msg); }
      catch (e) { st.error = "Kaydedilemedi: " + e.message; }
      draw();
    }

    root.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-p]");
      if (!el) return;
      const a = el.dataset.p;
      if (a === "open") {
        e.preventDefault();
        const f = st.rec.files.find((x) => x.id === el.dataset.id);
        if (!f) return;
        const blob = st.mem.get(f.id);
        if (blob) { window.open(URL.createObjectURL(f.ext === "pdf" ? new Blob([blob], { type: "application/pdf" }) : blob), "_blank"); return; }
        const { data, error } = await ctx.cloud.storage(BUCKET).createSignedUrl(f.storagePath, 3600, { download: f.ext !== "pdf" ? f.name : undefined });
        if (error) { ctx.toast && ctx.toast("Dosya açılamadı: " + error.message); return; }
        window.open(data.signedUrl, "_blank");
      } else if (a === "del") {
        const f = st.rec.files.find((x) => x.id === el.dataset.id);
        if (!f || !confirm(`"${f.name}" kaldırılsın mı?`)) return;
        if (ctx.cloud && f.storagePath) await ctx.cloud.storage(BUCKET).remove([f.storagePath]);
        st.rec.files = st.rec.files.filter((x) => x !== f); delete st.rec.texts[f.id]; st.mem.delete(f.id);
        if (st.rec.files.length) recompute(); else st.rec.summary = null;
        persist("Dosya kaldırıldı");
      } else if (a === "reanalyze") {
        st.busy = "Dokümanlar yeniden okunuyor…"; draw();
        try { await refreshTexts((m) => { const b = root.querySelector("#pDrop b"); if (b) b.textContent = m; }); } catch { /* kayıtlı metinle devam */ }
        st.busy = ""; recompute(); persist("Yeniden analiz edildi");
      } else if (a === "items") {
        st.showAllItems = !st.showAllItems; draw();
      } else if (a === "copy") {
        navigator.clipboard?.writeText(summaryText()).then(() => ctx.toast && ctx.toast("Proje özeti panoya kopyalandı"), () => ctx.toast && ctx.toast("Kopyalanamadı"));
      } else if (a === "pptx") {
        el.disabled = true; const label = el.textContent; el.textContent = "Sunum hazırlanıyor…";
        try {
          await loadModule("sunum.js", "TR_SUNUM");
          const name = await window.TR_SUNUM.download({ tender: t, rec: st.rec });
          ctx.toast && ctx.toast("Bid/No-Bid sunumu indirildi: " + name);
        } catch (err) { st.error = "Sunum oluşturulamadı: " + (err.message || err); draw(); return; }
        el.disabled = false; el.textContent = label;
      } else if (a === "word") {
        el.disabled = true; const label = el.textContent; el.textContent = "Rapor hazırlanıyor…";
        try {
          await loadReportLib();
          const name = await window.TR_RAPOR.download({ tender: t, rec: st.rec, watch: ctx.watch ? ctx.watch() : null });
          ctx.toast && ctx.toast("Word raporu indirildi: " + name);
        } catch (err) { st.error = "Word raporu oluşturulamadı: " + (err.message || err); draw(); return; }
        el.disabled = false; el.textContent = label;
      } else if (a === "print") {
        window.print();
      } else if (a === "key-clear") {
        e.preventDefault(); lsSet(PROVIDERS[provider()].keyStore, null); st.aiErr = null; draw();
      } else if (a === "prov") {
        lsSet(PROV_STORE, el.dataset.v); st.aiErr = null; draw();
      } else if (a === "ai") {
        const pv = provider();
        st.aiErr = null; st.busy = "Yapay zekâ özeti hazırlanıyor…"; draw();
        const status = () => root.querySelector("#aiCard .ai-status");
        try {
          st.rec.ai = await runAi(ctx, st.rec, st.mem, (m) => { const s = status(); if (s) s.textContent = m; });
          st.rec.ai.fileIds = st.rec.files.map((f) => f.id);   // sonradan doküman değişirse "yeniden oluştur" uyarısı için
          await saveRecord(ctx, st.rec);
          ctx.toast && ctx.toast("Yapay zekâ özeti hazır");
        } catch (err) {
          st.aiErr = aiErrorText(pv, err);
        }
        st.busy = ""; draw();
      }
    });
    root.addEventListener("change", (e) => {
      if (e.target.id === "pFile") { addFiles(e.target.files); return; }
      if (e.target.dataset.pmodel !== undefined) { lsSet(GMODEL_STORE, e.target.value); return; }
      const id = e.target.dataset.ptype;
      if (id) { const f = st.rec.files.find((x) => x.id === id); if (f) { f.type = e.target.value; recompute(); persist("Doküman türü güncellendi"); } }
    });
    root.addEventListener("submit", (e) => {
      if (e.target.dataset.pform !== "key") return;
      e.preventDefault();
      const fd = new FormData(e.target);
      const P = PROVIDERS[fd.get("prov")] || PROVIDERS[provider()];
      const v = String(fd.get("key") || "").replace(/\s+/g, "");
      if (!P.keyOk(v)) { st.aiErr = `Bu bir ${P.label} API anahtarına benzemiyor (beklenen biçim: ${P.keyHint}).`; draw(); return; }
      lsSet(P.keyStore, v); st.aiErr = null; draw();
      ctx.toast && ctx.toast(`${P.label} anahtarı bu tarayıcıya kaydedildi`);
    });
    root.addEventListener("dragover", (e) => { if (e.target.closest("#pDrop")) { e.preventDefault(); e.target.closest("#pDrop").classList.add("over"); } });
    root.addEventListener("dragleave", (e) => { const z = e.target.closest("#pDrop"); if (z) z.classList.remove("over"); });
    root.addEventListener("drop", (e) => { const z = e.target.closest("#pDrop"); if (!z) return; e.preventDefault(); z.classList.remove("over"); addFiles(e.dataTransfer.files); });

    init();
    return { isBusy: () => !!st.busy };
  }

  window.TR_PROJE = { mount, core: { extractFiles, buildSummary, classify, repairText, tidyItemName, TYPES } };
})();
