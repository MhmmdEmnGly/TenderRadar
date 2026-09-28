#requires -Version 5.1
<#
  Tender Radar veri toplayıcı — ek kurulum gerektirmez (Windows PowerShell 5.1).

  Kaynaklar:
    - ilan.gov.tr (Basın İlan Kurumu) JSON API: EKAP'a (4734) ve EDAŞ yönetmeliğine tabi ihale ilanları
    - Yatırımlar Dergisi (yatirimlar.com): sözleşme / ihale sonucu haberleri (bedel, yaklaşık maliyet, teklif sayısı, İKN)
    - RSS: Enerji Günlüğü, YeniEnerji, Google Haberler (anahtar kelime sorguları)

  Çıktı: ../data/tenders.js, news.js, sources.js   (yerel panel bu dosyaları okur)
  Kalıcı geçmiş: ./store/*.json   Ham önbellek: ./cache/

  -Cloud: GitHub Actions'ta çalışır. Anahtar kelimeleri ve geçmişi Supabase'den alır, sonucu Supabase'e yükler.
          Ortam değişkenleri: SUPABASE_URL, SUPABASE_SERVICE_KEY (GitHub Secrets)
#>
param(
  [switch]$Quiet,
  # Yalnızca keywords.json son taramadan beri değiştiyse çalış (30 dakikalık kontrol görevi bunu kullanır)
  [switch]$IfKeywordsChanged,
  # Bulut modu: Supabase'den oku / Supabase'e yaz
  [switch]$Cloud
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root   = Split-Path -Parent $PSScriptRoot
$Cfg    = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Cache  = Join-Path $PSScriptRoot 'cache'
$Store  = Join-Path $PSScriptRoot 'store'
$DataDir = Join-Path $Root 'data'
foreach ($d in @($Cache, "$Cache\ilan", "$Cache\yatirimlar", $Store, $DataDir, "$PSScriptRoot\logs")) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---------------------------------------------------------------- Anahtar kelimeler (tek kaynak: keywords.json)
# Panelin "Anahtar Kelimeler" sayfası bu dosyaya yazar. "pos" listesindeki her kelime ilan.gov.tr'de aranır ve
# ihalenin başlığında/konusunda geçmesi şartıyla listeye alınır; "neg" listesindekiler geçen ihaleler elenir.
$KwFile = Join-Path $PSScriptRoot 'keywords.json'
$KwScanned = Join-Path $Store 'keywords.scanned.json'

# ---------------------------------------------------------------- Bulut (Supabase REST) yardımcıları
function Invoke-Supabase([string]$Method, [string]$Path, $Body = $null, [hashtable]$Extra = @{}) {
  $key = $env:SUPABASE_SERVICE_KEY.Trim()
  # Yeni Supabase anahtarları (sb_secret_…) yalnızca "apikey" başlığıyla gönderilir; eski JWT anahtarlar Authorization da ister.
  $h = @{ apikey = $key }
  if (-not $key.StartsWith('sb_')) { $h.Authorization = "Bearer $key" }
  foreach ($k in $Extra.Keys) { $h[$k] = $Extra[$k] }
  # Secret anahtarlar tarayıcıdan gelen isteklerde reddedilir; PowerShell'in varsayılan "Mozilla…" kimliği tarayıcı sanılmasın
  $p = @{ Uri = "$($env:SUPABASE_URL.Trim().TrimEnd('/'))/rest/v1/$Path"; Method = $Method; Headers = $h; UseBasicParsing = $true; TimeoutSec = 120; UserAgent = 'TenderRadar-Scraper/1.0 (GitHub Actions)' }
  if ($null -ne $Body) {
    $p.Body = (New-Object Text.UTF8Encoding $false).GetBytes((ConvertTo-Json -InputObject $Body -Depth 12 -Compress))
    $p.ContentType = 'application/json; charset=utf-8'
  }
  $r = Invoke-WebRequest @p
  $ms = New-Object IO.MemoryStream; $r.RawContentStream.Position = 0; $r.RawContentStream.CopyTo($ms)
  $txt = [Text.Encoding]::UTF8.GetString($ms.ToArray())
  if (-not $txt.Trim()) { return $null }
  # PS 5.1: dizi JSON'u boru hattında tek nesne olarak gelir; değişkene alıp döndürünce satırlar tek tek akar
  $obj = ConvertFrom-Json -InputObject $txt
  return $obj
}

$CloudSettings = @{}
if ($Cloud) {
  if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_KEY) { throw 'Bulut modu için SUPABASE_URL ve SUPABASE_SERVICE_KEY ortam değişkenleri gerekli' }
  $u8 = New-Object Text.UTF8Encoding $false
  # Panelde düzenlenen anahtar kelimeler → keywords.json (yoksa repodaki varsayılan liste kullanılır ve buluta yüklenir)
  foreach ($row in @(Invoke-Supabase GET 'app_settings?select=key,value')) { if ($row) { $CloudSettings[$row.key] = $row.value } }
  if ($CloudSettings.keywords -and $CloudSettings.keywords.pos) {
    [IO.File]::WriteAllText($KwFile, (ConvertTo-Json -InputObject $CloudSettings.keywords -Depth 4), $u8)
  }
  # Geçmiş (firstSeen, eski sözleşmeler/haberler) → store/*.json  (Actions makinesi her seferinde sıfırdan başlar)
  foreach ($row in @(Invoke-Supabase GET 'datasets?select=key,data&key=in.(tenders,news)')) {
    if (-not $row) { continue }
    if ($row.key -eq 'tenders') { [IO.File]::WriteAllText((Join-Path $Store 'tenders.json'), (ConvertTo-Json -InputObject @($row.data) -Depth 12 -Compress), $u8) }
    if ($row.key -eq 'news') {
      [IO.File]::WriteAllText((Join-Path $Store 'news.json'), (ConvertTo-Json -InputObject @($row.data.news) -Depth 12 -Compress), $u8)
      [IO.File]::WriteAllText((Join-Path $Store 'deals.json'), (ConvertTo-Json -InputObject @($row.data.deals) -Depth 12 -Compress), $u8)
    }
  }
}
function Unique-Ci($items) {
  $seen = @{}; $out = New-Object System.Collections.ArrayList
  foreach ($i in $items) { $s = ([string]$i).Trim(); $k = $s.ToLower([Globalization.CultureInfo]::GetCultureInfo('tr-TR')).Replace('ı', 'i'); if ($s -and -not $seen[$k]) { $seen[$k] = 1; [void]$out.Add($s) } }
  return ,$out.ToArray()
}
if (-not (Test-Path $KwFile)) {
  $init = [ordered]@{ pos = (Unique-Ci (@($Cfg.ilanQueries) + @($Cfg.strongKeywords))); neg = (Unique-Ci $Cfg.negativeKeywords); updatedAt = (Get-Date).ToString('o') }
  [IO.File]::WriteAllText($KwFile, (ConvertTo-Json $init -Depth 4), (New-Object Text.UTF8Encoding $false))
}
$Kw = Get-Content $KwFile -Raw -Encoding UTF8 | ConvertFrom-Json
$KwHash = (Get-FileHash $KwFile -Algorithm SHA256).Hash
$SearchTerms = Unique-Ci $Kw.pos
$StrongTerms = Unique-Ci $Kw.pos
$NegTerms    = Unique-Ci $Kw.neg

if ($IfKeywordsChanged) {
  $prev = if (Test-Path $KwScanned) { (Get-Content $KwScanned -Raw -Encoding UTF8 | ConvertFrom-Json).hash } else { $null }
  if ($prev -eq $KwHash) { exit 0 }   # kelimeler değişmemiş → sessizce çık
}

# Aynı anda iki tarama çalışmasın (zamanlanmış görev + elle çalıştırma)
try { $LockHandle = [IO.File]::Open((Join-Path $Store '.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { if (-not $Quiet) { Write-Host 'Başka bir güncelleme zaten çalışıyor; çıkılıyor.' }; exit 0 }

$UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
$TR   = [Globalization.CultureInfo]::GetCultureInfo('tr-TR')
$Inv  = [Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object Text.UTF8Encoding $false
$Now  = [DateTimeOffset]::Now
$LogFile = Join-Path $PSScriptRoot ("logs\{0:yyyy-MM-dd}.log" -f (Get-Date))

function Log([string]$m) {
  $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $m
  if (-not $Quiet) { Write-Host $line }
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# ---------------------------------------------------------------- HTTP / metin yardımcıları
function Get-Text {
  param([string]$Url, [hashtable]$Headers = @{}, [string]$Method = 'GET', [string]$Body, [string]$ContentType)
  $p = @{ Uri = $Url; UserAgent = $UA; UseBasicParsing = $true; TimeoutSec = 40; Headers = $Headers; Method = $Method }
  if ($Body) { $p.Body = $Utf8.GetBytes($Body); $p.ContentType = $ContentType }
  for ($i = 1; $i -le 3; $i++) {
    try {
      $r = Invoke-WebRequest @p
      $ms = New-Object IO.MemoryStream
      $r.RawContentStream.Position = 0
      $r.RawContentStream.CopyTo($ms)
      return $Utf8.GetString($ms.ToArray())
    } catch {
      if ($i -eq 3) { throw }
      Start-Sleep -Seconds (2 * $i)
    }
  }
}

function Strip-Html([string]$h) {
  if (-not $h) { return '' }
  $h = [regex]::Replace($h, '(?is)<(script|style)[^>]*>.*?</\1>', ' ')
  $h = [regex]::Replace($h, '(?i)<br\s*/?>|</p>|</tr>|</div>', ' ')
  $h = [regex]::Replace($h, '<[^>]+>', ' ')
  $h = [Net.WebUtility]::HtmlDecode($h)
  return ([regex]::Replace($h, '\s+', ' ')).Trim()
}

function Lower([string]$s) { if ($s) { $s.ToLower($TR) } else { '' } }
function TitleTR([string]$s) { if ($s) { $TR.TextInfo.ToTitleCase($s.ToLower($TR)) } else { '' } }

function Shorten([string]$s, [int]$max = 320) {
  if (-not $s) { return '' }
  $s = $s.Trim()
  if ($s.Length -le $max) { return $s }
  $cut = $s.Substring(0, $max)
  $dot = $cut.LastIndexOf('. ')
  if ($dot -gt $max * 0.6) { return $cut.Substring(0, $dot + 1) }
  return ($cut.Substring(0, $cut.LastIndexOf(' ')).TrimEnd(',', ';', ':') + '…')
}

$KwRegexCache = @{}
function Match-Keywords([string]$text, $list) {
  # Kelime başı sınırı zorunlu ("dhmi" içinde "hmi" eşleşmesin); 4 harf ve altı kısaltmalarda kelime sonu da zorunlu
  # ("rtu" ≠ "kurtuluş", "plc" ≠ "hplc"), uzun kelimelerde Türkçe ek serbest ("otomasyonu", "kompanzasyon sistemi")
  # Türkçe küçültmede "IEC" → "ıec" olur; eşleştirmede ı/i farkı yok sayılır
  $t = (Lower $text).Replace('ı', 'i')
  @($list | Where-Object {
    $k = (Lower $_).Replace('ı', 'i')
    if (-not $KwRegexCache.ContainsKey($k)) {
      $tail = if ($k.Length -le 4) { '(?![\p{L}\p{N}])' } else { '' }
      $KwRegexCache[$k] = New-Object regex ('(?<![\p{L}\p{N}])' + [regex]::Escape($k) + $tail)
    }
    $KwRegexCache[$k].IsMatch($t)
  })
}

function Iso([datetime]$dt) {
  # Kaynak tarihleri Türkiye saatidir (UTC+3)
  (New-Object DateTimeOffset($dt, [TimeSpan]::FromHours(3))).ToString("yyyy-MM-dd'T'HH:mm:ssK", $Inv)
}

function Save-JsonFile($obj, [string]$path) {
  [IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $obj -Depth 8 -Compress), $Utf8)
}
function Load-JsonFile([string]$path) {
  if (Test-Path $path) { return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  return $null
}

$Months = @{ 'ocak'=1; 'şubat'=2; 'mart'=3; 'nisan'=4; 'mayıs'=5; 'haziran'=6; 'temmuz'=7; 'ağustos'=8; 'eylül'=9; 'ekim'=10; 'kasım'=11; 'aralık'=12 }
$MonthRx = '(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)'

function Parse-TrAmount([string]$num, [string]$unit, [string]$cur) {
  # "1.190.058.053" / "1.190.058.053,50" / "36.3" (başlıkta ondalık nokta) + Milyar/Milyon
  if ($unit) { $n = [decimal]::Parse(($num -replace ',', '.'), $Inv) }
  else { $n = [decimal]::Parse((($num -replace '\.', '') -replace ',', '.'), $Inv) }
  switch -Regex ($unit) { 'Milyar' { $n *= 1000000000 } 'Milyon' { $n *= 1000000 } }
  $c = switch -Regex ($cur) { 'Euro|Avro|EUR' { 'EUR' } 'Dolar|USD' { 'USD' } default { 'TRY' } }
  [ordered]@{ amount = [math]::Round($n, 2); currency = $c }
}

$SourceStatus = [ordered]@{}
function Set-Status([string]$id, [string]$status, [int]$count, [string]$msg = '') {
  $SourceStatus[$id] = [ordered]@{ status = $status; count = $count; lastRun = $Now.ToString('o'); message = $msg }
}

# ================================================================ 1) ilan.gov.tr ihaleleri
$IlanHeaders = @{
  'accept' = 'text/plain'; 'origin' = 'https://www.ilan.gov.tr'; 'referer' = 'https://www.ilan.gov.tr/ilan/tum-ilanlar'
  'x-request-origin' = 'IGT-UI'; 'x-requested-with' = 'XMLHttpRequest'
}

function Search-Ilan([string]$q, [int]$maxPages = 6) {
  # API sayfa başına en fazla 20 kayıt döndürüyor → sayfalayarak topla
  $all = New-Object System.Collections.ArrayList
  for ($page = 0; $page -lt $maxPages; $page++) {
    $keys = [ordered]@{ q = @($q); ats = @(3) }
    if ($page -gt 0) { $keys.currentPage = @($page + 1) }
    $body = ConvertTo-Json -Compress -Depth 5 -InputObject ([ordered]@{ keys = $keys; skipCount = $page * 20; maxResultCount = 20 })
    $json = Get-Text -Url 'https://www.ilan.gov.tr/api/api/services/app/Ad/AdsByFilter' -Headers $IlanHeaders -Method POST -Body $body -ContentType 'application/json-patch+json'
    $res = ($json | ConvertFrom-Json).result
    $ads = @($res.ads | Where-Object { $_ })
    foreach ($a in $ads) { [void]$all.Add($a) }
    if ($ads.Count -lt 20 -or $all.Count -ge [int]$res.numFound) { break }
    Start-Sleep -Milliseconds 250
  }
  return $all
}

function Get-IlanDetail([string]$id) {
  $f = Join-Path "$Cache\ilan" "$id.json"
  if (Test-Path $f) { return (Load-JsonFile $f) }
  Start-Sleep -Milliseconds 300
  $json = Get-Text -Url "https://www.ilan.gov.tr/api/api/services/app/AdDetail/GetAdDetail?id=$id" -Headers $IlanHeaders
  $d = ($json | ConvertFrom-Json).result
  $rec = [ordered]@{
    id = $id; title = $d.title; advertiser = $d.advertiserName; city = $d.addressCityName; county = $d.addressCountyName
    urlStr = $d.urlStr; text = (Strip-Html $d.content); estimated = $d.attrEstimatedPrice
    filters = @($d.adTypeFilters | ForEach-Object { [ordered]@{ key = $_.key; value = $_.value } })
  }
  Save-JsonFile $rec $f
  return ($rec | ConvertTo-Json -Depth 5 | ConvertFrom-Json)
}

function Get-Filter($rec, [string]$key) { ($rec.filters | Where-Object { $_.key -eq $key } | Select-Object -First 1).value }

function Find-TenderDate($rec) {
  # Öncelik: (1) metindeki "son teklif verme/teslim" tarihi-saati (EDAŞ'larda asıl son tarih budur)
  #          (2) ilan.gov.tr yapısal alanı "İhale ve Teklif Açma Tarihi" (saatli)
  #          (3) metindeki ihale tarih-saati  (4) yapısal alan (yalnız tarih)
  $t = $rec.text
  $d = '(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4})'
  $h = '(\d{1,2})[:.](\d{2})'
  $mk = { param($m) New-Object DateTime ([int]$m.Groups[3].Value), ([int]$m.Groups[2].Value), ([int]$m.Groups[1].Value), ([int]$m.Groups[4].Value), ([int]$m.Groups[5].Value), 0 }

  $deadline = "(?:Son Teklif Verme|Tekliflerin (?:Nihai )?Teslim|Tekliflerin Sunulacağı En Son|Teklif(?:lerin)? (?:Sunma|Verme|Teslim) Son|Tekliflerin (?:en geç|son))[^0-9]{0,45}$d[^0-9]{0,30}$h"
  $m = [regex]::Match($t, $deadline, 'IgnoreCase')
  if ($m.Success) { try { return @{ date = (& $mk $m); timeKnown = $true; kind = 'Teklif son teslim' } } catch { } }

  $f = Get-Filter $rec 'İhale ve Teklif Açma Tarihi'
  if ($f -and $f -match '^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})') {
    return @{ date = (New-Object DateTime ([int]$Matches[3]), ([int]$Matches[2]), ([int]$Matches[1]), ([int]$Matches[4]), ([int]$Matches[5]), 0); timeKnown = $true; kind = 'İhale tarihi' }
  }
  foreach ($p in @(
    "(?:İhale(?:nin)?|2\.1\.?)\s*Tarih(?:i)? ve Saati\s*:?\s*$d[^0-9]{0,25}$h",
    "Tarih(?:i)? ve [Ss]aati\s*:?\s*$d[^0-9]{0,25}$h",
    "İhale Tarih(?:i)?[- ]?(?:Saati)?\s*:?.{0,300}?$d[^0-9]{0,25}$h")) {
    $m = [regex]::Match($t, $p, 'IgnoreCase')
    if ($m.Success) { try { return @{ date = (& $mk $m); timeKnown = $true; kind = 'İhale tarihi' } } catch { } }
  }
  if ($f -and $f -match '^(\d{2})\.(\d{2})\.(\d{4})') {
    return @{ date = (New-Object DateTime ([int]$Matches[3]), ([int]$Matches[2]), ([int]$Matches[1]), 23, 59, 0); timeKnown = $false; kind = 'İhale tarihi' }
  }
  return $null
}

function Find-Summary($rec) {
  $t = $rec.text
  $pats = @(
    'Niteliği,? [Tt]ürü ve [Mm]iktarı\s*:\s*(.{15,700}?)(?=\s+\d\.\d\.?\s|\s+\d+\s*[-–]\s|\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+ (?:yeri|süresi)\s*:|$)',
    'İhale [Kk]onusu (?:iş|işin kapsamı)\s*[;:]\s*(.{15,600}?)(?=\s+\d\.\s|$)',
    'İhale [Kk]onusu(?: [İi]ş)?\s*:\s*(.{15,500}?)(?=\s+\d\.\d|\s+\d\.\s|$)',
    '[Kk]apsamı\s*:?\s*(.{15,500}?)(?=\s+\d\.\s|$)'
  )
  foreach ($p in $pats) {
    $m = [regex]::Match($t, $p)
    if ($m.Success) {
      $s = $m.Groups[1].Value.Trim()
      $s = [regex]::Replace($s, '^(?:İhale Kayıt No\s+)?İhale Konusu\s+İhale Tarih-Saati\s+\S+\s+', '')
      return (Shorten $s 360)
    }
  }
  $i = $t.IndexOf('İhaleye ilişkin')
  if ($i -lt 0) { $i = 0 }
  return (Shorten $t.Substring($i) 300)
}

function Find-FormalTitle($rec) {
  $m = [regex]::Match($rec.text, '3\.1\.?\s*Adı\s*:\s*(.{5,250}?)\s+3\.2')
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  $s = $rec.title
  return ($s.Substring(0, 1).ToUpper($TR) + $s.Substring(1))
}

$CategoryMap = [ordered]@{
  'SCADA'              = @('scada', 'rtu', 'telekontrol', 'adms', 'oms', 'iec 60870', 'uzaktan kumanda')
  'Otomasyon'          = @('otomasyon', 'plc', 'dcs', 'hmi', 'kontrol sistemi')
  'Enerji Dağıtım'     = @('dağıtım merkezi', 'trafo merkezi', 'kompanzasyon', 'og hücre', 'fider', 'elektrik dağıtım')
  'Koruma'             = @('iec 61850', 'koruma röle', 'röle')
  'Telemetri / İzleme' = @('telemetri', 'uzaktan izleme', 'enerji izleme', 'enerji yönetim')
  'OSOS / Akıllı Sayaç'= @('akıllı sayaç', 'osos')
}

function Collect-Tenders {
  $ids = @{}
  $okQueries = 0
  foreach ($q in $SearchTerms) {
    try {
      $ads = @(Search-Ilan $q)
      $okQueries++
      foreach ($a in $ads) { if (-not $a.isArchived) { $ids[[string]$a.id] = $a } }
      Log ("ilan.gov.tr  '{0}': {1} ilan" -f $q, $ads.Count)
    } catch { Log ("ilan.gov.tr  '{0}' HATA: {1}" -f $q, $_.Exception.Message) }
    Start-Sleep -Milliseconds 250
  }
  if ($okQueries -eq 0) { throw 'ilan.gov.tr araması hiç yanıt vermedi' }
  Log ("ilan.gov.tr  toplam benzersiz ilan: {0}" -f $ids.Count)

  $out = New-Object System.Collections.ArrayList
  foreach ($id in $ids.Keys) {
    try { $rec = Get-IlanDetail $id } catch { Log "  detay alınamadı $id : $($_.Exception.Message)"; continue }
    $summary = Find-Summary $rec
    $title = Find-FormalTitle $rec
    $focus = "$($rec.title) $title $summary"
    if ((Match-Keywords "$focus $($rec.advertiser)" $NegTerms).Count) { continue }
    $strong = Match-Keywords $focus $StrongTerms
    if (-not $strong.Count) { continue }   # yalnızca başlıkta/konu tanımında güçlü eşleşme olanlar

    $date = Find-TenderDate $rec
    if (-not $date) { continue }
    $usul = Get-Filter $rec 'İhale Usulü'
    $tur = Get-Filter $rec 'İhale Türü'
    $ikn = $null
    $m = [regex]::Match($rec.text, '(?:İKN|İhale Kayıt Numarası)[^0-9]{0,25}(\d{4})\s*/\s*(\d{3,})')
    if ($m.Success) { $ikn = "$($m.Groups[1].Value)/$($m.Groups[2].Value)" }

    $srcType = if ("$usul $($rec.advertiser)" -match 'Elektrik Dağıtım|ELEKTRİK DAĞITIM|EDAŞ') { 'EDAS' }
               elseif ($ikn) { 'EKAP' }
               elseif ($rec.advertiser -match 'ORGANİZE SANAYİ|OSB') { 'OSB' }
               else { 'ILAN' }
    $ilanUrl = "https://www.ilan.gov.tr$($rec.urlStr)"
    $ekapUrl = if ($ikn) { "https://ekapv2.kik.gov.tr/ekap/search/$($ikn -replace '/', '_')" } else { $null }

    $cats = New-Object System.Collections.ArrayList
    foreach ($k in $CategoryMap.Keys) { if ((Match-Keywords $focus $CategoryMap[$k]).Count) { [void]$cats.Add($k) } }
    if ($tur) { [void]$cats.Add($tur) }

    $refNo = $ikn
    if (-not $refNo) { $refNo = ([string](Get-Filter $rec 'İhale Kayıt No')).Trim() }
    if (-not $refNo) {
      # Referans no mutlaka rakam içermeli ("Dosya Numarası İşin Adı" gibi tablo başlıkları eşleşmesin)
      $km = [regex]::Match($rec.text, '(?:İhale (?:Kayıt|Referans) No|İhale No|Dosya (?:No|Numarası))\.?\s*:?\s*(?:İhale Konusu\s+İhale Tarih-Saati\s+)?(?=[\w\-/.]*\d)([A-ZÇĞİÖŞÜ0-9][\w\-/.]{2,30})')
      # Yedek: "2026.ÇEDAŞ.YAP.74" / "VEDAS.26.146" gibi hem harf hem rakam içeren noktalı dosya no (tarih değil)
      if (-not $km.Success) { $km = [regex]::Match($rec.text, '\b((?=[A-ZÇĞİÖŞÜ0-9.]*\d)(?=[A-ZÇĞİÖŞÜ0-9.]*[A-ZÇĞİÖŞÜ])[A-ZÇĞİÖŞÜ0-9]{2,}(?:\.[A-ZÇĞİÖŞÜ0-9]{2,}){2,})\b') }
      $refNo = if ($km.Success) { $km.Groups[1].Value.TrimEnd('.') } else { $null }
    }

    # İptal / zeyilname (düzeltme) ilanları: ayrı işaretlenir, başlık anlaşılır hale getirilir
    $isCancel = [bool]("$($rec.title) $($rec.urlStr)" -match '(?i)iptal')
    $isAddendum = [bool]("$($rec.title) $($rec.urlStr)" -match '(?i)zeyilname|düzeltme|duzeltme|erteleme')
    if ($title -match '^(?i)(düzeltme|ihale iptal|iptal) ilanı') {
      $prefix = if ($isCancel) { 'İPTAL' } else { 'Zeyilname' }
      $wm = [regex]::Match($rec.text, '(?:ZEYİLNAME İLANI|DÜZELTME İLANI|İPTAL İLANI)\s+(.{8,140}?(?:İŞİ|ALIMI|PROJESİ|İŞİnde|ALIM İŞİ))')
      $title = "$prefix — " + $(if ($wm.Success) { (TitleTR ($wm.Groups[1].Value -replace 'İŞİnde$', 'İŞİ')) } else { Shorten $summary 110 })
    }

    [void]$out.Add([ordered]@{
      id = "ilan-$id"
      title = $title
      summary = $summary
      authority = $rec.advertiser
      sourceType = $srcType
      sourceName = if ($srcType -eq 'EKAP') { 'EKAP (ilan.gov.tr üzerinden)' } else { 'ilan.gov.tr' }
      city = (TitleTR $rec.city)
      county = $rec.county
      ikn = $ikn
      refNo = $refNo
      adNo = $id
      tenderDate = (Iso $date.date)
      dateKind = $date.kind
      timeKnown = $date.timeKnown
      procedure = (@($usul, $tur) | Where-Object { $_ }) -join ' · '
      estimatedValue = if ($rec.estimated) { [ordered]@{ amount = [double]$rec.estimated; currency = 'TRY' } } else { $null }
      categories = @($cats | Select-Object -Unique)
      matched = @($strong)
      isAddendum = $isAddendum
      isCancelled = $isCancel
      url = if ($ekapUrl) { $ekapUrl } else { $ilanUrl }
      ekapUrl = $ekapUrl
      ilanUrl = $ilanUrl
      firstSeen = $Now.ToString('o')
    })
  }
  return $out
}

# ================================================================ 2) Yatırımlar Dergisi
function Get-YatirimlarArticle([string]$url) {
  $idm = [regex]::Match($url, '_(\d+)$')
  $f = Join-Path "$Cache\yatirimlar" "$($idm.Groups[1].Value).json"
  if (Test-Path $f) { return (Load-JsonFile $f) }
  Start-Sleep -Milliseconds 400
  $html = Get-Text -Url $url
  $text = Strip-Html $html
  $start = [regex]::Match($text, 'Dergi:\s*\d+\s*')
  $body = if ($start.Success) { $text.Substring($start.Index + $start.Length) } else { $text }
  $end = $body.IndexOf('BENZER HABERLER')
  if ($end -gt 0) { $body = $body.Substring(0, $end) }
  $body = ($body -replace 'https?://\S+', '').Trim()
  # Yayın tarihi başlığın hemen altında, "Durum:" alanından önce yer alır
  # (sayfanın en üstündeki tarih günün tarihidir, haberin değil)
  $date = $null
  $dm = [regex]::Match($text, "(\d{1,2}) $MonthRx (\d{4})[^0-9]{0,80}Durum:")
  if ($dm.Success) { $date = Iso (New-Object DateTime ([int]$dm.Groups[3].Value), $Months[(Lower $dm.Groups[2].Value)], ([int]$dm.Groups[1].Value), 9, 0, 0) }
  $rec = [ordered]@{ url = $url; date = $date; body = (Shorten $body 1500) }
  Save-JsonFile $rec $f
  return ($rec | ConvertTo-Json | ConvertFrom-Json)
}

function Classify-News([string]$title) {
  $t = Lower $title
  if ($t -match 'sözleşme imzala|sözleşme daveti|anlaşma imzala|ihalesini kazandı|kazandı|üstlendi') { return 'sozlesme' }
  if ($t -match 'ihale(si)? sonuç|sonuçlandı|en düşük teklif|teklifler? (açıldı|toplandı|alındı)|teklif veren') { return 'sonuc' }
  if ($t -match 'ihale(ye)? (açtı|açıldı|ilanı|çıkıldı|çıkıyor)|ihaleye çık|ön yeterlik') { return 'ihale' }
  if ($t -match 'yatırım|epdk|yönetmelik|karar|tarife|mevzuat|plan|hedef|kapasite') { return 'yatirim' }
  return 'haber'
}

function Get-Sector([string]$headline, [string]$body = '') {
  # Önce başlığa göre karar ver; başlık belirsizse haber metnine bak
  if ($body) {
    $s = Get-Sector $headline
    if ($s -ne 'Diğer') { return $s }
    return (Get-Sector $body)
  }
  $t = Lower $headline
  if ($t -match 'scada|otomasyon|telekontrol|kontrol sistem') { return 'Otomasyon / SCADA' }
  if ($t -match 'arıtma|atık ?su|içme ?suyu|kanalizasyon') { return 'Su / Atıksu' }
  if ($t -match 'elektrik dağıtım|edaş|trafo|teiaş|elektrik şebeke|enerji nakil|kompanzasyon') { return 'Enerji Dağıtım / İletim' }
  if ($t -match '\bges\b|\bres\b|\bhes\b|güneş|rüzgar|yenilenebilir|depolama|santral|enerji|euaş|eüaş|doğal ?gaz|botaş') { return 'Enerji Üretim' }
  if ($t -match 'arıtma|atık ?su|içme ?suyu|\bsu\b|dsi|dsİ|baraj|sulama|isk[iİ]|ski\b') { return 'Su / Atıksu' }
  if ($t -match 'demiryolu|raylı|metro|tramvay|tcdd|yht|hafif raylı') { return 'Raylı Sistem' }
  if ($t -match 'otoyol|karayolu|köprü|tünel|kgm') { return 'Karayolu' }
  if ($t -match 'havalimanı|liman|rıhtım') { return 'Havalimanı / Liman' }
  return 'Diğer'
}

function Parse-Deal([string]$headline, $art) {
  $h = $headline
  $b = [string]$art.body
  if ((Classify-News $h) -ne 'sozlesme') { return $null }
  $winner = $null; $headClient = $null; $subjectOverride = $null
  # 1) "X, ... Türk Firması Y İle Anlaşma İmzaladı" → yüklenici Y, işveren X
  $m = [regex]::Match($h, '^(.{3,80}?),\s*(.+?)\s+Türk Firması (.{2,60}?) [İi]le (?:Sözleşme|Anlaşma)')
  if ($m.Success) { $winner = $m.Groups[3].Value; $headClient = $m.Groups[1].Value; $subjectOverride = $m.Groups[2].Value -replace '\s+(İçin|için)$', '' }
  # 2) "İşveren İş için Yüklenici ile Sözleşme İmzaladı"
  if (-not $winner) {
    $m = [regex]::Match($h, '^(.+?) için (.{3,80}?) [İi]le (?:Sözleşme|Anlaşma)')
    if ($m.Success) { $winner = $m.Groups[2].Value; $subjectOverride = $m.Groups[1].Value }
  }
  # 3) "Yüklenici, İş için ... Sözleşme İmzaladı / İhalesini Kazandı"
  if (-not $winner) { $m = [regex]::Match($h, '^(.{3,100}?),\s'); if ($m.Success) { $winner = $m.Groups[1].Value } }
  # 4) Haber metni: "ihaleyi kazanan X ile"
  if (-not $winner) { $m = [regex]::Match($b, 'kazanan (.{3,100}?) ile'); if ($m.Success) { $winner = $m.Groups[1].Value } }
  if (-not $winner) { return $null }

  $amount = $null
  $m = [regex]::Match($b, '(\d{1,3}(?:\.\d{3})+(?:,\d+)?)\s*(TL|Euro|Avro|ABD Doları|Dolar|USD|EUR)\s+(?:üzerinden|bedel)')
  if ($m.Success) { $amount = Parse-TrAmount $m.Groups[1].Value '' $m.Groups[2].Value }
  if (-not $amount) {
    $m = [regex]::Match($h, '(\d+(?:[.,]\d+)?)\s*(Milyar|Milyon)\s*(Liralık|Dolarlık|Euroluk|Avroluk)')
    if ($m.Success) { $amount = Parse-TrAmount $m.Groups[1].Value $m.Groups[2].Value $m.Groups[3].Value }
  }
  $est = $null
  $m = [regex]::Match($b, '[Yy]aklaşık maliyeti\s*(\d{1,3}(?:\.\d{3})+(?:,\d+)?)\s*(TL|Euro|Avro|ABD Doları|Dolar|USD|EUR)')
  if ($m.Success) { $est = Parse-TrAmount $m.Groups[1].Value '' $m.Groups[2].Value }
  $bids = $null
  $m = [regex]::Match($b, 'toplam teklif sayısı\s*(\d+)')
  if ($m.Success) { $bids = [int]$m.Groups[1].Value }
  $ikn = $null
  $m = [regex]::Match($b, 'KİK:?\s*(\d{4}/\d+)')
  if ($m.Success) { $ikn = $m.Groups[1].Value }
  $client = $null
  $m = [regex]::Match($b, "^(.{4,160}?)\s+(?:\d{1,2}\s+$MonthRx\s+\d{4}\s+tarihinde|tarafından|,)")
  if ($m.Success) { $client = $m.Groups[1].Value.Trim() }
  if (-not $client -and $headClient) { $client = $headClient }
  if ($client -and $client.Length -gt 140) { $client = $null }

  $subject = if ($subjectOverride) { $subjectOverride } else { $h }
  if ($subject.StartsWith("$winner,")) { $subject = $subject.Substring($winner.Length + 1).Trim() }
  elseif ((Lower $subject).StartsWith((Lower $winner))) { $subject = $subject.Substring($winner.Length).Trim() }
  $subject = [regex]::Replace($subject, '\s*(?:için\s*)?(?:\d+(?:[.,]\d+)?\s*(?:Milyar|Milyon)\s*\S+\s*)?(?:Sözleşme İmzaladı|Sözleşme Daveti Aldı|İhalesini Kazandı|İhalesini Üstlendi|Kazandı|Üstlendi|Anlaşma İmzaladı)\.?$', '')
  $subject = [regex]::Replace($subject, "'(?:n?[ıiuü]n|n?in)\b", '')

  $type = if ($h -match 'Daveti') { 'Sözleşme daveti' } elseif ($h -match 'Kazandı|Üstlendi') { 'İhale sonucu' } else { 'Sözleşme' }
  [ordered]@{
    winner = $winner.Trim(); client = $client; subject = $subject.Trim(); amount = $amount; estimate = $est; bidders = $bids
    ikn = $ikn; ekapUrl = $(if ($ikn) { "https://ekapv2.kik.gov.tr/ekap/search/$($ikn -replace '/', '_')" } else { $null })
    type = $type
  }
}

function Collect-Yatirimlar {
  $items = [ordered]@{}
  foreach ($page in $Cfg.yatirimlarPages) {
    try {
      $html = Get-Text -Url $page
      foreach ($m in [regex]::Matches($html, '<a[^>]+href="(https://yatirimlar\.com/haber/[^"]+_\d+)"[^>]*>([\s\S]{10,400}?)</a>')) {
        $t = Strip-Html $m.Groups[2].Value
        if ($t.Length -ge 25 -and -not $items.Contains($m.Groups[1].Value)) { $items[$m.Groups[1].Value] = $t }
      }
    } catch { Log "  Yatırımlar sayfası alınamadı: $page" }
    Start-Sleep -Milliseconds 400
  }
  Log ("Yatırımlar Dergisi: {0} başlık" -f $items.Count)
  $news = New-Object System.Collections.ArrayList
  $deals = New-Object System.Collections.ArrayList
  foreach ($url in $items.Keys) {
    $headline = $items[$url]
    try { $art = Get-YatirimlarArticle $url } catch { Log "  makale alınamadı: $url"; continue }
    $id = 'yat-' + [regex]::Match($url, '_(\d+)$').Groups[1].Value
    $date = if ($art.date) { $art.date } else { $Now.ToString('o') }
    $type = Classify-News $headline
    [void]$news.Add([ordered]@{
      id = $id; type = $type; title = $headline; summary = (Shorten ([string]$art.body) 280); source = 'Yatırımlar Dergisi'
      url = $url; publishedAt = $date; tags = @(Get-Sector $headline ([string]$art.body))
    })
    $deal = Parse-Deal $headline $art
    if ($deal) {
      $deal['id'] = $id; $deal['date'] = $date; $deal['source'] = 'Yatırımlar Dergisi'; $deal['url'] = $url
      $deal['headline'] = $headline; $deal['sector'] = Get-Sector $headline ([string]$art.body)
      [void]$deals.Add($deal)
    }
  }
  return @{ news = $news; deals = $deals }
}

# ================================================================ 3) RSS
function Read-Rss([string]$url) {
  $xml = [xml](Get-Text -Url $url)
  $items = @($xml.rss.channel.item)
  foreach ($it in $items) {
    $title = [string]$it.title
    if ($title -is [Xml.XmlElement]) { $title = $it.title.InnerText }
    $src = if ($it.source) { if ($it.source -is [string]) { $it.source } else { $it.source.'#text' } } else { $null }
    $pub = $null
    try { $pub = [DateTimeOffset]::Parse([string]$it.pubDate, $Inv).ToString('o') } catch { }
    $desc = $it.description
    if ($desc -isnot [string]) { $desc = $it.description.InnerText }
    [pscustomobject]@{ title = $title; link = [string]$it.link; pubDate = $pub; source = $src; description = (Strip-Html $desc) }
  }
}

function Collect-Rss {
  $news = New-Object System.Collections.ArrayList
  $cut = $Now.AddDays(-[int]$Cfg.newsDays)
  foreach ($f in $Cfg.rssFeeds) {
    try {
      $n = 0
      foreach ($it in (Read-Rss $f.url)) {
        if (-not $it.pubDate -or [DateTimeOffset]::Parse($it.pubDate) -lt $cut) { continue }
        if ($f.filter -and -not (Match-Keywords "$($it.title) $($it.description)" $Cfg.newsKeywords).Count) { continue }
        [void]$news.Add([ordered]@{
          id = "$($f.id)-" + [Math]::Abs($it.link.GetHashCode()); type = (Classify-News $it.title); title = $it.title
          summary = (Shorten $it.description 280); source = $f.name; url = $it.link; publishedAt = $it.pubDate
          tags = @(Get-Sector $it.title ([string]$it.description))
        }); $n++
      }
      Set-Status $f.id 'ok' $n
      Log ("{0}: {1} haber" -f $f.name, $n)
    } catch { Set-Status $f.id 'err' 0 $_.Exception.Message; Log ("{0} HATA: {1}" -f $f.name, $_.Exception.Message) }
  }
  $g = 0; $gErr = $null
  foreach ($q in $Cfg.googleNewsQueries) {
    try {
      $u = 'https://news.google.com/rss/search?q=' + [uri]::EscapeDataString("$q when:30d") + '&hl=tr&gl=TR&ceid=TR:tr'
      foreach ($it in (Read-Rss $u | Select-Object -First 25)) {
        if (-not $it.pubDate -or [DateTimeOffset]::Parse($it.pubDate) -lt $cut) { continue }
        $title = $it.title
        $src = $it.source
        if ($src -and $title.EndsWith(" - $src")) { $title = $title.Substring(0, $title.Length - $src.Length - 3) }
        if (-not (Match-Keywords $title $Cfg.newsKeywords).Count) { continue }
        [void]$news.Add([ordered]@{
          id = 'gn-' + [Math]::Abs($title.GetHashCode()); type = (Classify-News $title); title = $title
          summary = ''; source = $(if ($src) { $src } else { 'Google Haberler' }); url = $it.link; publishedAt = $it.pubDate
          tags = @(Get-Sector $title); via = 'Google Haberler'
        }); $g++
      }
      Start-Sleep -Milliseconds 300
    } catch { $gErr = $_.Exception.Message; Log ("Google Haberler '{0}' HATA: {1}" -f $q, $gErr) }
  }
  Set-Status 'gnews' $(if ($g -gt 0 -or -not $gErr) { 'ok' } else { 'err' }) $g $gErr
  Log ("Google Haberler: {0} haber" -f $g)
  return $news
}

# ================================================================ Birleştirme / kalıcı geçmiş
function Merge-Store([string]$name, $fresh, [string]$dateField, [int]$keepDays, [string[]]$preserve = @(), [switch]$DropFutureMissing) {
  # DropFutureMissing: tarihi henüz gelmemiş ama bu taramada artık bulunmayan kayıtlar silinir
  # (filtre kuralı değişti ya da ilan kaldırıldı); tarihi geçmişler geçmiş olarak saklanır.
  $path = Join-Path $Store "$name.json"
  $map = [ordered]@{}
  $old = Load-JsonFile $path
  $freshIds = @{}
  foreach ($f in $fresh) { $freshIds[[string]$f.id] = 1 }
  if ($old) {
    foreach ($o in $old) {
      if ($DropFutureMissing -and -not $freshIds[[string]$o.id] -and $o.$dateField -and [DateTimeOffset]::Parse($o.$dateField) -ge $Now) { continue }
      $map[[string]$o.id] = $o
    }
  }
  foreach ($f in $fresh) {
    $fo = [pscustomobject]$f
    $prev = $map[[string]$fo.id]
    if ($prev) { foreach ($p in $preserve) { if ($prev.$p) { $fo.$p = $prev.$p } } }
    $map[[string]$fo.id] = $fo
  }
  $cut = $Now.AddDays(-$keepDays)
  $list = @($map.Values | Where-Object { -not $_.$dateField -or [DateTimeOffset]::Parse($_.$dateField) -ge $cut })
  Save-JsonFile $list $path
  return $list
}

function To-JsJson($value) {
  (ConvertTo-Json -InputObject $value -Depth 8 -Compress) -replace [char]0x2028, ' ' -replace [char]0x2029, ' '
}
function Write-Atomic([string]$path, [string]$content) {
  # Önce geçici dosyaya yaz, sonra yerine koy: panel yarım yazılmış dosya okumasın
  $tmp = "$path.tmp"
  [IO.File]::WriteAllText($tmp, $content, $Utf8)
  # PowerShell $null'ı boş metne çevirir; .NET'e gerçek null geçmek için [NullString]::Value
  if (Test-Path $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
}
function Write-DataJs([string]$file, [System.Collections.IDictionary]$props) {
  $js = "/* Otomatik üretildi: scraper/Update-TenderRadar.ps1 — $($Now.ToString('yyyy-MM-dd HH:mm')) — elle düzenlemeyin */`n" +
        "window.TR_DATA = window.TR_DATA || {};`nwindow.TR_DATA.demo = false;`nwindow.TR_DATA.generatedAt = '$($Now.ToString('o'))';`n"
  foreach ($k in $props.Keys) { $js += "window.TR_DATA.$k = $(To-JsJson $props[$k]);`n" }
  Write-Atomic (Join-Path $DataDir $file) $js
}

# ================================================================ Çalıştır
Log '===== Tender Radar güncelleme başladı ====='

try {
  $tenders = Collect-Tenders
  # Aynı ihalenin zeyilname/düzeltme ilanlarını tekilleştir (İKN veya idare+başlık)
  $byKey = [ordered]@{}
  foreach ($t in ($tenders | Sort-Object { [int]$_.adNo })) {
    $key = if ($t.ikn) { $t.ikn } else { (Lower "$($t.authority)|$($t.title -replace '(?i)\s*-?\s*zeyilname.*$', '')") }
    if ($byKey.Contains($key)) { $t.isAddendum = $true }
    $byKey[$key] = $t
  }
  $tenders = @($byKey.Values)
  $tenders = Merge-Store 'tenders' $tenders 'tenderDate' ([int]$Cfg.historyDays) @('firstSeen') -DropFutureMissing
  Set-Status 'ilan' 'ok' ($tenders | Where-Object { [DateTimeOffset]::Parse($_.tenderDate) -ge $Now }).Count
  Log ("İhaleler: {0} kayıt (geçmiş dahil)" -f $tenders.Count)
} catch {
  Set-Status 'ilan' 'err' 0 $_.Exception.Message
  Log "İHALE TOPLAMA HATASI: $($_.Exception.Message)"
  $tenders = @(Load-JsonFile (Join-Path $Store 'tenders.json'))
}

$yat = @{ news = @(); deals = @() }
try {
  $yat = Collect-Yatirimlar
  Set-Status 'yatirimlar' 'ok' $yat.news.Count
} catch { Set-Status 'yatirimlar' 'err' 0 $_.Exception.Message; Log "Yatırımlar HATA: $($_.Exception.Message)" }

$rss = @()
try { $rss = Collect-Rss } catch { Log "RSS HATA: $($_.Exception.Message)" }

# Haberleri başlığa göre tekilleştir (aynı haber birden çok kaynaktan gelebilir)
$seen = @{}
$allNews = New-Object System.Collections.ArrayList
foreach ($n in (@($yat.news) + @($rss))) {
  $k = ((Lower $n.title) -replace '[^a-zçğıöşü0-9]', '')
  if ($k.Length -gt 60) { $k = $k.Substring(0, 60) }
  if (-not $seen[$k]) { $seen[$k] = 1; [void]$allNews.Add($n) }
}
$news  = Merge-Store 'news'  $allNews 'publishedAt' ([int]$Cfg.newsDays)
$deals = Merge-Store 'deals' $yat.deals 'date' ([int]$Cfg.historyDays)
Set-Status 'deals' 'ok' $deals.Count

$news  = @($news  | Sort-Object { [DateTimeOffset]::Parse($_.publishedAt) } -Descending)
$deals = @($deals | Sort-Object { [DateTimeOffset]::Parse($_.date) } -Descending)

# Kaynak kataloğu (arayüzdeki Kaynaklar sayfası)
$catalog = @(
  [ordered]@{ id='ilan'; name='ilan.gov.tr — İhale ilanları (EKAP + EDAŞ)'; group='İhaleler'; url='https://www.ilan.gov.tr/ilan/tum-ilanlar/ihale'; method='api'; note='Basın İlan Kurumu portalı. 4734 ilanlarında İKN okunur ve EKAP sayfasına doğrudan link verilir; EDAŞ yönetmeliğine tabi ihaleler de buradan gelir.' }
  [ordered]@{ id='ekap'; name='EKAP (KİK) — doğrudan API'; group='İhaleler'; url='https://ekapv2.kik.gov.tr/ekap/search'; method='browser'; note='Cloudflare Turnstile korumalı. İhaleler ilan.gov.tr üzerinden İKN ile eşleştirilerek EKAP linki üretiliyor; tam EKAP entegrasyonu Python kurulumu gerektirir.'; status='planned' }
  [ordered]@{ id='yatirimlar'; name='Yatırımlar Dergisi'; group='Piyasa & Sözleşmeler'; url='https://yatirimlar.com/'; method='html'; note='Sözleşme / ihale sonucu haberleri: yüklenici, bedel, yaklaşık maliyet, teklif sayısı, İKN.' }
  [ordered]@{ id='deals'; name='Sözleşme tablosu (Yatırımlar Dergisi haberlerinden)'; group='Piyasa & Sözleşmeler'; url='https://yatirimlar.com/'; method='html'; note='Haber metninden otomatik ayrıştırılır; kaynağa link verilir.' }
  [ordered]@{ id='enerjigunlugu'; name='Enerji Günlüğü'; group='Piyasa & Sözleşmeler'; url='https://www.enerjigunlugu.net/'; method='rss' }
  [ordered]@{ id='yenienerji'; name='YeniEnerji'; group='Piyasa & Sözleşmeler'; url='https://www.yenienerji.com/'; method='rss' }
  [ordered]@{ id='gnews'; name='Google Haberler (anahtar kelime sorguları)'; group='Piyasa & Sözleşmeler'; url='https://news.google.com/search?q=SCADA%20ihale&hl=tr&gl=TR&ceid=TR:tr'; method='rss'; note=('Sorgular: ' + ($Cfg.googleNewsQueries -join ', ')) }
  [ordered]@{ id='kap'; name='KAP — Yeni İş İlişkisi bildirimleri'; group='Piyasa & Sözleşmeler'; url='https://www.kap.org.tr/tr/bildirim-sorgu'; method='api'; note='Sonraki adımda eklenecek.'; status='planned' }
)
foreach ($c in $catalog) {
  $s = $SourceStatus[$c.id]
  if ($s) { foreach ($k in $s.Keys) { $c[$k] = $s[$k] } } elseif (-not $c.status) { $c.status = 'planned' }
}

$kwInfo = [ordered]@{ pos = @($Kw.pos); neg = @($Kw.neg); updatedAt = $Kw.updatedAt; scannedAt = $Now.ToString('o'); hash = $KwHash }

Write-DataJs 'tenders.js' ([ordered]@{ tenders = $tenders })
Write-DataJs 'news.js' ([ordered]@{ news = $news; deals = $deals })
Write-DataJs 'sources.js' ([ordered]@{ sources = $catalog; keywords = $kwInfo })
# Sürüm dosyası EN SON yazılır: panel bunu dakikada bir kontrol eder, değiştiyse kendini yeniler
$version = [ordered]@{ generatedAt = $Now.ToString('o'); tenderIds = @($tenders | ForEach-Object { $_.id }) }
Write-Atomic (Join-Path $DataDir 'version.js') ("window.TR_DATA_VERSION = $(To-JsJson $version);`n")
Save-JsonFile $kwInfo $KwScanned

if ($Cloud) {
  # Tek istekte (tek işlem) tüm veri setlerini yaz; panel "version" satırındaki zamana bakarak kendini yeniler.
  # keywordsUpdatedAt: GitHub Actions'taki kontrol adımı, paneldeki kelimeler değişti mi diye buna bakar.
  $stamp = $Now.ToString('o')
  $rows = @(
    [ordered]@{ key = 'tenders'; data = @($tenders); generated_at = $stamp }
    [ordered]@{ key = 'news'; data = [ordered]@{ news = @($news); deals = @($deals) }; generated_at = $stamp }
    [ordered]@{ key = 'sources'; data = [ordered]@{ sources = @($catalog); keywords = $kwInfo }; generated_at = $stamp }
    [ordered]@{ key = 'version'; data = [ordered]@{ generatedAt = $stamp; tenderIds = @($tenders | ForEach-Object { $_.id }); keywordsUpdatedAt = $Kw.updatedAt }; generated_at = $stamp }
  )
  Invoke-Supabase POST 'datasets?on_conflict=key' $rows @{ Prefer = 'resolution=merge-duplicates,return=minimal' } | Out-Null
  # Bulutta henüz kelime listesi yoksa repodaki varsayılan listeyi yükle (panel bunu gösterip düzenleyebilsin)
  if (-not ($CloudSettings.keywords -and $CloudSettings.keywords.pos)) {
    $kwRow = @([ordered]@{ key = 'keywords'; value = [ordered]@{ pos = @($Kw.pos); neg = @($Kw.neg); updatedAt = $Kw.updatedAt }; updated_at = $stamp })
    Invoke-Supabase POST 'app_settings?on_conflict=key' $kwRow @{ Prefer = 'resolution=merge-duplicates,return=minimal' } | Out-Null
  }
  Log 'Supabase: veri setleri yüklendi'
}

Log ("Bitti: {0} ihale, {1} haber, {2} sözleşme · aranan kelime: {3}" -f $tenders.Count, $news.Count, $deals.Count, $SearchTerms.Count)
$LockHandle.Close()
