#!/usr/bin/env python3
"""
Tender Radar — Kamu İhale Bülteni (KİK) toplayıcı.

KİK her gün Mal / Yapım / Hizmet / Danışmanlık bültenlerini PDF olarak herkese açık yayımlar
(https://ekap.kik.gov.tr/ekap/ilan/bultenindirme.aspx). 4734 sayılı Kanun gereği ihale SONUÇ
ilanları da bu bültenlerde yer alır: yaklaşık maliyet, sözleşme bedeli, yüklenici, teklif sayısı.

Bu betik bülteni sayfanın kendi "indir" işleviyle (günde birkaç dosya, istekler arasında bekleme)
indirir, PDF metninden sonuç ilanlarını ayrıştırır.

Kullanım:
  python bulten.py --probe                 # yapıyı incele (test)
  python bulten.py --days 3 --out out.json # son 3 günün bültenlerini ayrıştır
"""
import argparse, io, json, re, sys, time, zipfile, datetime as dt
import requests
from pypdf import PdfReader

URL = "https://ekap.kik.gov.tr/ekap/ilan/bultenindirme.aspx"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 TenderRadar/1.0"
TYPES = {"Mal": ("lnkBtnMal", "1"), "Yapım": ("lnkBtnYapim", "2"), "Hizmet": ("lnkBtnHizmet", "3"), "Danışmanlık": ("lnkBtnDanismanlik", "4")}
PREFIX = "ctl00$ContentPlaceHolder1$"


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
    """Bir bülteni indirir; PDF baytlarını döndürür (yoksa None)."""
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    html = s.get(URL, timeout=60).text
    f = form_fields(html)
    btn, code = TYPES[kind]
    if day == today:
        f["__EVENTTARGET"] = PREFIX + btn
    else:  # arşiv: tür + tarih seçip "Bülten İndir"
        f["__EVENTTARGET"] = PREFIX + "btnYukle"
        f[PREFIX + "ddlstBxIhaleTur"] = code
        f[PREFIX + "etBultenTarihi$EkapTakvimTextBox_etBultenTarihi"] = day.strftime("%d.%m.%Y")
    f["__EVENTARGUMENT"] = ""
    r = s.post(URL, data=f, headers={"Referer": URL, "Origin": "https://ekap.kik.gov.tr"}, timeout=180)
    if not r.content.startswith(b"PK"):
        return None
    z = zipfile.ZipFile(io.BytesIO(r.content))
    pdfs = [n for n in z.namelist() if n.lower().endswith(".pdf")]
    return z.read(pdfs[0]) if pdfs else None


def pdf_text(pdf_bytes):
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "\n".join((p.extract_text() or "") for p in reader.pages), len(reader.pages)


def notice(title, msg):
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::notice title={title}::{msg}")


def probe():
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=3))).date()
    for kind in ("Yapım", "Mal"):
        pdf = download(kind, today, today)
        if not pdf:
            notice(f"Bülten {kind}", "indirilemedi"); continue
        text, pages = pdf_text(pdf)
        keys = ["SONUÇ İLANI", "Sonuç İlanı", "Sözleşmenin", "Yüklenici", "İhale kayıt numarası", "İKN", "Bedeli", "Yaklaşık Maliyeti", "İHALE İLANI", "İPTAL"]
        counts = ", ".join(f"{k}={text.count(k)}" for k in keys)
        notice(f"Bülten {kind} yapı", f"{pages} sayfa, {len(text)} karakter | {counts}")
        i = text.find("Sözleşmenin")
        if i < 0:
            i = text.find("Yüklenici")
        if i >= 0:
            notice(f"Bülten {kind} sonuç örneği", text[max(0, i - 1500):i + 700])
        notice(f"Bülten {kind} başlangıç", text[:1200])
        time.sleep(3)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true")
    a = ap.parse_args()
    try:
        if a.probe:
            probe()
    except Exception as e:  # hata metni Actions özetinde (girişsiz) görünsün
        import traceback
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        print(f"::error title=Bülten hatası::{type(e).__name__}: {e} | {tb[-1500:]}".replace("\n", "%0A"))
        sys.exit(1)
