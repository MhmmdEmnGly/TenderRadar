#!/usr/bin/env python3
"""
Tender Radar — Kamu İhale Bülteni (KİK) toplayıcı.

KİK her iş günü Mal / Yapım / Hizmet / Danışmanlık bültenlerini PDF olarak herkese açık yayımlar
(https://ekap.kik.gov.tr/ekap/ilan/bultenindirme.aspx). Bültende 4734 kapsamındaki tüm ihale
ilanları, ön ilanlar, düzeltme ve İPTAL ilanları, istisna ve kapsam dışı ilanlar bulunur.
(Sonuç ilanları — sözleşme bedeli, yüklenici — bültende YOKTUR; yalnızca EKAP'ta.)

Bu betik bültenleri sayfanın kendi indirme işleviyle indirir (istekler arasında bekleyerek),
PDF metninden ilanları ayrıştırır ve Supabase'deki public.bulten_ilan tablosuna yazar.

Ortam: SUPABASE_URL, SUPABASE_SERVICE_KEY
Kullanım:
  python bulten.py                   # bugünün bültenleri + arşivden en fazla 10 işlenmemiş gün
  python bulten.py --backfill 20     # arşivden en fazla 20 gün
  python bulten.py --probe           # yapı incelemesi (test)
"""
import argparse, io, json, os, re, ssl, sys, time, zipfile, datetime as dt
import requests
from requests.adapters import HTTPAdapter
from pypdf import PdfReader

URL = "https://ekap.kik.gov.tr/ekap/ilan/bultenindirme.aspx"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 TenderRadar/1.0"
TYPES = {"Mal": ("lnkBtnMal", "1"), "Yapım": ("lnkBtnYapim", "2"), "Hizmet": ("lnkBtnHizmet", "3"), "Danışmanlık": ("lnkBtnDanismanlik", "4")}
PREFIX = "ctl00$ContentPlaceHolder1$"
TZ = dt.timezone(dt.timedelta(hours=3))
HISTORY_DAYS = 370          # arşivde geriye en fazla bu kadar gün
PAUSE = 3                   # istekler arası bekleme (sn)
LAST_FAIL = ""


class LegacyTLS(HTTPAdapter):
    """EKAP'ın eski sunucusu yalnızca eski şifreleme takımlarını kabul ediyor (SECLEVEL=1).
    Sertifika doğrulaması AÇIK kalır; yalnızca şifre takımı alt sınırı düşürülür."""
    def init_poolmanager(self, *a, **kw):
        ctx = ssl.create_default_context()
        ctx.set_ciphers("DEFAULT@SECLEVEL=1")
        kw["ssl_context"] = ctx
        return super().init_poolmanager(*a, **kw)


# ------------------------------------------------------------------ İndirme
def form_fields(html):
    f = {}
    for tag in re.findall(r"<input[^>]+>", html):
        n = re.search(r'name="([^"]+)"', tag)
        if not n:
            continue
        t = re.search(r'type="([^"]+)"', tag)
        if t and t.group(1) in ("submit", "button", "image", "checkbox", "radio"):
            continue
        v = re.search(r'value="([^"]*)"', tag)
        f[n.group(1)] = (v.group(1) if v else "").replace("&amp;", "&").replace("&quot;", '"').replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
    for n in re.findall(r'<select[^>]+name="([^"]+)"', html):
        f[n] = "0"
    return f


def download(kind, day, today):
    """Bir bülteni indirir; PDF baytlarını döndürür (o gün bülten yoksa None)."""
    global LAST_FAIL
    s = requests.Session()
    s.mount("https://ekap.kik.gov.tr", LegacyTLS())
    s.headers.update({"User-Agent": UA})
    html = s.get(URL, timeout=60).text
    f = form_fields(html)
    btn, code = TYPES[kind]
    if day == today:
        f["__EVENTTARGET"] = PREFIX + btn
    else:
        f["__EVENTTARGET"] = PREFIX + "btnYukle"
        f[PREFIX + "ddlstBxIhaleTur"] = code
        f[PREFIX + "etBultenTarihi$EkapTakvimTextBox_etBultenTarihi"] = day.strftime("%d.%m.%Y")
    f["__EVENTARGUMENT"] = ""
    r = s.post(URL, data=f, headers={"Referer": URL, "Origin": "https://ekap.kik.gov.tr"}, timeout=180)
    if not r.content.startswith(b"PK"):
        LAST_FAIL = "yayımlanmamış" if "yayımlanmamıştır" in r.text else f"HTTP {r.status_code}"
        return None
    z = zipfile.ZipFile(io.BytesIO(r.content))
    pdfs = [n for n in z.namelist() if n.lower().endswith(".pdf")]
    return z.read(pdfs[0]) if pdfs else None


def pdf_text(pdf_bytes):
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


# ------------------------------------------------------------------ Ayrıştırma
# Bölüm başlıkları (önce daha özel olanlar)
SECTIONS = [
    ("ÇERÇEVE ANLAŞMA İHALE DÜZELTME", "cerceve_duzeltme"), ("ÇERÇEVE ANLAŞMA İHALE İPTAL", "cerceve_iptal"),
    ("ÇERÇEVE ANLAŞMA İHALE İLAN", "cerceve"), ("İHALE ÖN İLAN", "on"), ("İHALE DÜZELTME", "duzeltme"),
    ("İHALE İPTAL", "iptal"), ("İSTİSNA İPTAL", "istisna_iptal"), ("İSTİSNA DÜZELTME", "istisna_duzeltme"),
    ("İSTİSNA ZEYİLNAME", "istisna_duzeltme"), ("İSTİSNA İHALE", "istisna"), ("KAPSAM DIŞI İPTAL", "kd_iptal"),
    ("KAPSAM DIŞI DÜZELTME", "kd_duzeltme"), ("KAPSAM DIŞI ZEYİLNAME", "kd_duzeltme"), ("KAPSAM DIŞI SA", "kd_satis"),
    ("KAPSAM DIŞI İHALE", "kapsamdisi"), ("İHALE İLANLARI", "ilan"),
]
# Bölüm başlığı satırı: "2. İHALE İLANLARI", "4. İSTİSNA İPTAL İLANLARI" … (satırın tamamı büyük harf)
RX_SEC = re.compile(r"^\s*(?:[A-Z]-\s*)?\d+\.\s+([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ \-]{5,}?)\s*$")
RX_ITEM = re.compile(r"^\s*(\d+)\.\s+(\d{4}/\d{3,})\s+(.+?)\s*$")
RX_NOISE = re.compile(r"^\s*(KAMU İHALE BÜLTENİ|Kamu İhale Kurumu\s*[–-]|[A-ZÇĞİÖŞÜ ]+ İHALELERİ BÜLTENİ\s*$|\d+\s*$)")
TR_UP = str.maketrans("abcçdefgğhıijklmnoöprsştuüvyzqwx", "ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZQWX")


def up_tr(s):
    return (s or "").translate(TR_UP).upper() if s else s


def clean(s, n=None):
    s = re.sub(r"\s+", " ", s or "").strip(" :;,-")
    return s[:n] if n else s


def fold(s):
    return (s or "").lower().replace("i̇", "i").replace("ı", "i").replace("İ".lower(), "i")


def kw_match(text, words):
    t = fold(text.replace("İ", "i").replace("I", "ı"))
    out = []
    for w in words:
        k = fold(w.replace("İ", "i").replace("I", "ı"))
        tail = r"(?![\w])" if len(k) <= 4 else ""
        if re.search(r"(?<![\w])" + re.escape(k) + tail, t):
            out.append(w)
    return out


def parse(text, kind, day, pos, neg):
    rows, sec, cur = [], None, None

    def flush():
        if not cur or not sec:
            return
        body = " ".join(cur["lines"])
        m = re.search(r"1\.1\.\s*Adı\s*:\s*(.+?)\s+1\.2\.", body) or re.search(r"İdarenin\s+[Aa]dı\s*:\s*(.+?)\s{2,}", body)
        idare = clean(m.group(1), 250) if m else None
        m = re.search(r"1\.2\.\s*Adresi\s*:\s*(.+?)\s+1\.3\.", body)
        il = None
        if m:
            parts = re.findall(r"/\s*([A-Za-zÇĞİÖŞÜçğıöşü]+)", m.group(1))
            il = parts[-1] if parts else None
        m = re.search(r"2\.1\.\s*Tarih(?:i)? ve [Ss]aati\s*:\s*(\d{2})\.(\d{2})\.(\d{4})\s*-?\s*(\d{2}):(\d{2})", body)
        tarih = f"{m.group(3)}-{m.group(2)}-{m.group(1)}T{m.group(4)}:{m.group(5)}:00+03:00" if m else None
        m = re.search(r"3\.1\.\s*Adı\s*:\s*(.+?)\s+3\.2\.", body)
        is_adi = clean(m.group(1), 300) if m else clean(cur["title"], 300)
        m = re.search(r"3\.2\.\s*Niteliği,?\s*türü ve miktarı\s*:\s*(.+?)(?:\s+Ayrıntılı [Bb]ilgi|\s+3\.3\.)", body)
        nitelik = clean(m.group(1), 400) if m else None
        head = body[:700].lower()
        usul = ("Açık" if "açık ihale usul" in head else "Belli istekliler" if "belli istekliler" in head
                else "Pazarlık" if "pazarlık" in head else None)
        focus = f"{cur['title']} {is_adi} {nitelik or ''}"
        hits = kw_match(focus, pos)
        excluded = kw_match(f"{focus} {idare or ''}", neg)
        rows.append({
            "ikn": cur["ikn"], "sec": sec, "bulten_tarihi": day.isoformat(), "tur": kind,
            "idare": up_tr(idare) if idare else None, "il": il.capitalize() if il else None,
            "is_adi": is_adi, "nitelik": nitelik, "ihale_tarihi": tarih, "usul": usul,
            "eihale": "elektronik ortamda" in head, "ilgili": bool(hits) and not excluded, "kw": hits,
        })

    started = False
    for line in text.splitlines():
        if "...." in line:                      # içindekiler satırı
            continue
        m = RX_SEC.match(line)
        if m and not RX_ITEM.match(line):
            title = up_tr(m.group(1))
            for key, code in SECTIONS:
                if key in title:
                    flush(); cur = None; sec = code; started = True
                    break
            continue
        if not started or RX_NOISE.match(line):
            continue
        m = RX_ITEM.match(line)
        if m:
            flush()
            cur = {"ikn": m.group(2), "title": m.group(3), "lines": []}
            continue
        if cur is not None:
            cur["lines"].append(line.strip())
    flush()
    # Aynı gün + bölüm + İKN tekrarlarını birleştir (kısmi ilanlar)
    uniq = {}
    for r in rows:
        uniq[(r["ikn"], r["sec"], r["bulten_tarihi"])] = r
    return list(uniq.values())


# ------------------------------------------------------------------ Supabase
def sb(method, path, body=None, prefer=None):
    key = os.environ["SUPABASE_SERVICE_KEY"].strip()
    h = {"apikey": key, "User-Agent": "TenderRadar-Bulten/1.0", "Content-Type": "application/json"}
    if not key.startswith("sb_"):
        h["Authorization"] = f"Bearer {key}"
    if prefer:
        h["Prefer"] = prefer
    r = requests.request(method, os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/" + path, headers=h,
                         data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None, timeout=120)
    if r.status_code >= 300:
        raise RuntimeError(f"Supabase {method} {path.split('?')[0]} → {r.status_code}: {r.text[:300]}")
    return r.json() if r.text.strip() else None


def keywords():
    try:
        v = sb("GET", "app_settings?key=eq.keywords&select=value")
        if v and v[0]["value"].get("pos"):
            return v[0]["value"]["pos"], v[0]["value"].get("neg", [])
    except Exception:
        pass
    k = json.load(open(os.path.join(os.path.dirname(__file__), "keywords.json"), encoding="utf-8"))
    return k["pos"], k.get("neg", [])


def notice(title, msg, level="notice"):
    print(f"::{level} title={title}::" + str(msg).replace("%", "%25").replace("\r", "").replace("\n", "%0A"))


# ------------------------------------------------------------------ Çalıştır
def run(backfill):
    now = dt.datetime.now(TZ)
    today = now.date()
    pos, neg = keywords()
    meta_rows = sb("GET", "datasets?key=eq.bulten_meta&select=data") or []
    meta = meta_rows[0]["data"] if meta_rows else {}
    done = set(meta.get("processed", []))
    empty = set(meta.get("empty", []))                    # bülten yayımlanmamış günler (tatil)

    # İşlenecek günler: bugün (08:00 TR sonrası) + arşivde işlenmemiş en yeni günler
    days = []
    if today.weekday() < 5 and today.isoformat() not in done and now.hour >= 8:
        days.append(today)
    d = today - dt.timedelta(days=1)
    while len(days) < backfill + (1 if days and days[0] == today else 0) and (today - d).days <= HISTORY_DAYS:
        if d.weekday() < 5 and d.isoformat() not in done and d.isoformat() not in empty:
            days.append(d)
        d -= dt.timedelta(days=1)

    total, relevant, cancelled = 0, 0, 0
    for day in days:
        got, rows = 0, []
        for kind in TYPES:
            try:
                pdf = download(kind, day, today)
            except Exception as e:
                notice("Bülten indirilemedi", f"{day} {kind}: {type(e).__name__}: {e}", "warning")
                pdf = None
            time.sleep(PAUSE)
            if not pdf:
                continue
            got += 1
            rows += parse(pdf_text(pdf), kind, day, pos, neg)
        if not got:
            if day != today:
                empty.add(day.isoformat())
            continue
        for i in range(0, len(rows), 400):
            sb("POST", "bulten_ilan?on_conflict=ikn,sec,bulten_tarihi", rows[i:i + 400], "resolution=merge-duplicates,return=minimal")
        done.add(day.isoformat())
        total += len(rows); relevant += sum(r["ilgili"] for r in rows); cancelled += sum(r["sec"].endswith("iptal") for r in rows)
        print(f"{day}: {got} bülten, {len(rows)} ilan ({sum(r['ilgili'] for r in rows)} ilgili)")

    meta = {"processed": sorted(done)[-HISTORY_DAYS:], "empty": sorted(empty)[-120:], "updatedAt": now.isoformat(),
            "oldest": min(done) if done else None, "newest": max(done) if done else None, "dayCount": len(done)}
    sb("POST", "datasets?on_conflict=key", [{"key": "bulten_meta", "data": meta, "generated_at": now.isoformat()}], "resolution=merge-duplicates,return=minimal")
    notice("Kamu İhale Bülteni", f"{len(days)} gün işlendi · {total} ilan · {relevant} ilgili · {cancelled} iptal · "
           f"arşiv: {meta['dayCount']} gün ({meta['oldest']} → {meta['newest']})")


def probe():
    today = dt.datetime.now(TZ).date()
    pos, neg = ["scada", "otomasyon", "telemetri", "trafo merkezi", "kompanzasyon", "plc", "rtu"], ["akaryakıt"]
    for kind in ("Yapım", "Mal"):
        pdf = download(kind, today, today)
        if not pdf:
            notice(f"Probe {kind}", "indirilemedi: " + LAST_FAIL); continue
        rows = parse(pdf_text(pdf), kind, today, pos, neg)
        by = {}
        for r in rows:
            by[r["sec"]] = by.get(r["sec"], 0) + 1
        filled = {k: sum(1 for r in rows if r.get(k)) for k in ("idare", "il", "ihale_tarihi", "nitelik", "usul")}
        notice(f"Probe {kind}", f"{len(rows)} ilan · bölümler {by} · dolu alanlar {filled}")
        for r in [x for x in rows if x["sec"] == "ilan"][:2] + [x for x in rows if x["sec"] == "iptal"][:1] + [x for x in rows if x["ilgili"]][:2]:
            notice(f"Örnek {kind} {r['sec']}", json.dumps(r, ensure_ascii=False)[:900])
        time.sleep(PAUSE)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--backfill", type=int, default=10)
    a = ap.parse_args()
    try:
        probe() if a.probe else run(a.backfill)
    except Exception as e:  # hata metni Actions özetinde (girişsiz) görünsün
        import traceback
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        notice("Bülten hatası", f"{type(e).__name__}: {e} | {tb[-1200:]}", "error")
        sys.exit(1)
