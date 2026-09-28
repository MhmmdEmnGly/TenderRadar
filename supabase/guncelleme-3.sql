-- Tender Radar — güncelleme 3: Kamu İhale Bülteni (KİK) ilanları
-- Supabase → SQL Editor → New query → yapıştır → Run. Tekrar çalıştırmak güvenlidir.
--
-- KİK'in herkese açık günlük bültenlerindeki tüm ihale ilanları (ihale, ön ilan, düzeltme, iptal, istisna,
-- kapsam dışı) bu tabloya yazılır. Kurum analitiği, ihale sonuç takibi ve pano bu tabloyu kullanır.
-- Yazma yalnızca GitHub Actions (service_role) ile; okuma yalnızca giriş yapmış kullanıcı.

create table if not exists public.bulten_ilan (
  ikn            text not null,
  sec            text not null,              -- ilan | on | duzeltme | iptal | cerceve | istisna | kapsamdisi | ...
  bulten_tarihi  date not null,
  tur            text,                       -- Mal | Yapım | Hizmet | Danışmanlık
  idare          text,                       -- büyük harfe normalize
  il             text,
  is_adi         text,
  nitelik        text,
  ihale_tarihi   timestamptz,
  usul           text,
  eihale         boolean,
  ilgili         boolean not null default false,   -- anahtar kelimelere uyuyor mu
  kw             text[] not null default '{}',
  eklendi        timestamptz not null default now(),
  primary key (ikn, sec, bulten_tarihi)
);
create index if not exists bulten_ilan_idare_idx  on public.bulten_ilan (idare);
create index if not exists bulten_ilan_ilgili_idx on public.bulten_ilan (ilgili) where ilgili;
create index if not exists bulten_ilan_ikn_idx    on public.bulten_ilan (ikn);
create index if not exists bulten_ilan_tarih_idx  on public.bulten_ilan (bulten_tarihi);

alter table public.bulten_ilan enable row level security;
drop policy if exists "bulten okuma" on public.bulten_ilan;
create policy "bulten okuma" on public.bulten_ilan for select to authenticated using (true);

-- Kurum özeti (tüm alım türleri): ihale sayısı, ilgili ihale, iptal, türlere göre dağılım
create or replace view public.bulten_idare_ozet with (security_invoker = true) as
select idare,
       mode() within group (order by il)                                   as il,
       count(*) filter (where sec = 'ilan')                                 as ihale,
       count(*) filter (where sec = 'ilan' and ilgili)                      as ilgili,
       count(*) filter (where sec = 'iptal')                                as iptal,
       count(*) filter (where sec = 'duzeltme')                             as duzeltme,
       count(*) filter (where sec = 'ilan' and tur = 'Mal')                 as mal,
       count(*) filter (where sec = 'ilan' and tur = 'Yapım')               as yapim,
       count(*) filter (where sec = 'ilan' and tur = 'Hizmet')              as hizmet,
       count(*) filter (where sec = 'ilan' and tur = 'Danışmanlık')         as danismanlik,
       count(*) filter (where sec = 'ilan' and eihale)                      as eihale,
       min(bulten_tarihi)                                                   as ilk,
       max(bulten_tarihi)                                                   as son
from public.bulten_ilan
where idare is not null
group by idare;

-- Kurum × ay × tür (aylık grafikler)
create or replace view public.bulten_aylik with (security_invoker = true) as
select idare, date_trunc('month', bulten_tarihi)::date as ay, tur,
       count(*) as adet, count(*) filter (where ilgili) as ilgili
from public.bulten_ilan
where sec = 'ilan' and idare is not null
group by idare, date_trunc('month', bulten_tarihi), tur;

-- İl özeti (harita)
create or replace view public.bulten_il_ozet with (security_invoker = true) as
select il, count(*) filter (where sec = 'ilan') as ihale, count(*) filter (where sec = 'ilan' and ilgili) as ilgili,
       count(distinct idare) as idare_sayisi
from public.bulten_ilan
where il is not null
group by il;

grant select on public.bulten_ilan, public.bulten_idare_ozet, public.bulten_aylik, public.bulten_il_ozet to authenticated;
