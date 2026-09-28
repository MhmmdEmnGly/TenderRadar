# Tender Radar

Otomasyon & SCADA odaklı ihale, piyasa, müşteri ve rakip takip paneli — iş geliştirme için.

- **İhaleler:** ilan.gov.tr (EKAP / 4734 ve EDAŞ ihaleleri). Kalan süreye göre sınıflandırma (3 günden az / 3–7 gün / 7+ gün), EKAP'a İKN ile doğrudan link.
- **Piyasa & sözleşmeler:** Yatırımlar Dergisi, Enerji Günlüğü, YeniEnerji, Google Haberler — yüklenici, bedel, yaklaşık maliyet, kırım, teklif sayısı.
- **Müşteri kartları, takip listesi, sabah özeti, rakip analizi.**
- Kullanıcı adı + şifre ile giriş; veriler cihazlar arası senkron.

## Mimari
| Parça | Teknoloji |
|---|---|
| Panel | Statik HTML/CSS/JS → GitHub Pages |
| Giriş ve veri | Supabase (Auth + Postgres, satır güvenliği açık) |
| Tarama | GitHub Actions (Windows PowerShell 5.1 betiği) |

Repoda veri bulunmaz. Kurulum için: [SETUP.md](SETUP.md)
