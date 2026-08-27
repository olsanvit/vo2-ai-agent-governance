-- ============================================================================
-- Pesapallo Data Manager — SportProgress slot remediation
-- Incident: scheduled run 2026-08-24 15:39 UTC (Manager, GovernanceVersion 11.2.2)
-- Autor: Pesapallo Data Manager (governance routine)
-- ----------------------------------------------------------------------------
-- KONTEXT / ROOT CAUSE
--   Běh nenašel žádné zápasy (0) a nedokázal posunout sloty. Dvě příčiny:
--
--   1) DEAD off-season seed. Všech 7 SportProgress slotů stálo na 1929-01-01..07.
--      Pesäpallo je LETNÍ sport (sezóna ~ květen–září). Leden je mimo sezónu,
--      takže WebSearch pro tato data vždy vrátí 0 zápasů. Navíc denní výsledky
--      z roku 1929 nejsou digitálně dohledatelné → slot by nikdy nenašel data.
--      Divergence: inline KROK 8 (CCR cron prompt) inicializuje sloty na
--      "1919-01-01" fixním krokem +7d / threshold 3 a NEIMPLEMENTUJE
--      ManagerPrompt.txt Ch 19 (11.2.2) — dynamický krok dle days_behind +
--      off-season detekci. Ch 19 je správně, ale inline prompt je zastaralý.
--
--   2) Row-lock na SportProgress. Úvodní dávka 8 paralelních upsertů na stejné
--      řádky (SlotIndex 1..7) zanechala hung transakce; následné upserty na
--      SportProgress trvale timeoutovaly (30s), zatímco zápisy do jiných tabulek
--      (AgentRunReports, AgentSchedules) i čtení fungovaly.
--
-- APLIKACE: spustit na AIDB Postgresu (AIData). Bloky 1–3 dle potřeby.
-- Idempotentní: lze spustit opakovaně.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BLOK 1 — Uvolnit zaseknuté transakce na SportProgress (Fix #2)
--   Nejprve diagnostika, poté ukončení "idle in transaction" backendů, které
--   drží zámek na SportProgress. (Alternativně samo odezní přes
--   idle_in_transaction_session_timeout, je-li nastaven.)
-- ----------------------------------------------------------------------------
SELECT pid, state, wait_event_type, xact_start, left(query, 90) AS last_query
FROM   pg_stat_activity
WHERE  state LIKE 'idle in transaction%'
  AND  query ILIKE '%SportProgress%';

-- Po ověření výše ukončit:
SELECT pg_terminate_backend(pid)
FROM   pg_stat_activity
WHERE  state LIKE 'idle in transaction%'
  AND  query ILIKE '%SportProgress%';

-- ----------------------------------------------------------------------------
-- BLOK 2 — Přeseedovat 7 slotů do sezóny s dohledatelnými výsledky (Fix #1)
--   Volba: sezóna 2019 (moderní Superpesis, výsledky online, mimo COVID rok
--   2020). Týdenní rozestup pokryje různé týdny sezóny a sníží překryv slotů.
--   Governance: SlotDate se posouvá pouze VPŘED (1929 -> 2019 je vpřed = OK).
--   Operátor může zvolit jinou éru (např. 1990 = vznik Superpesis) — jen NIKDY
--   zimní měsíc a NIKDY rok bez digitálně dostupných denních výsledků.
-- ----------------------------------------------------------------------------
UPDATE "SportProgress" AS sp
SET    "SlotDate"   = v.d::date,
       "EmptyCount" = 0
FROM  (VALUES
         (1, '2019-05-06'),
         (2, '2019-05-13'),
         (3, '2019-05-20'),
         (4, '2019-05-27'),
         (5, '2019-06-03'),
         (6, '2019-06-10'),
         (7, '2019-06-17')
      ) AS v(idx, d)
WHERE sp."SportKey" = 'Pesapallo'
  AND sp."SlotIndex" = v.idx;

-- Kontrola:
SELECT "SlotIndex", "SlotDate", "EmptyCount"
FROM   "SportProgress"
WHERE  "SportKey" = 'Pesapallo'
ORDER  BY "SlotIndex";

-- ----------------------------------------------------------------------------
-- BLOK 3 — Označit pesäpallo jako sezónní sport (Fix #3)
--   Aktivuje off-season detekci v ManagerPrompt.txt Ch 19 (11.2.2), takže
--   budoucí běhy rychleji přeskočí mimosezónní data místo plýtvání WebSearch.
--   Pozn.: sloupce IsSeasonalSport / SeasonMonths vytvořit pokud chybí
--   (ensure_columns v runtime). Sezóna pesäpallo ~ květen–září.
-- ----------------------------------------------------------------------------
-- ALTER TABLE "Sports" ADD COLUMN IF NOT EXISTS "IsSeasonalSport" boolean DEFAULT false;
-- ALTER TABLE "Sports" ADD COLUMN IF NOT EXISTS "SeasonMonths"    text;
UPDATE "Sports"
SET    "IsSeasonalSport" = true,
       "SeasonMonths"    = '5,6,7,8,9'
WHERE  "NormalizedName" = 'pesapallo';

-- ============================================================================
-- NÁSLEDNÉ KROKY (mimo SQL) — pro trvalou nápravu:
--   A) Inline KROK 8 v CCR cron promptu Pesapallo Data Manager sladit s Ch 19:
--      - seed sezónních sportů do IN-SEASON měsíce (ne leden)
--      - dynamický krok dle days_behind (>365: +30d/th1, 90–365: +7d/th2, <90: +1d/th3)
--      - zápisy do SportProgress provádět SEKVENČNĚ, ne paralelní dávkou
--        (paralelní upserty na stejné řádky = lock kontence, viz BLOK 1)
--   B) Zvážit doplnění "stale-slot escape" do Ch 19: pokud je slot > 2 roky
--      pozadu a nikdy nenašel zápas, skočit +1 rok ve stejném sezónním okně.
-- ============================================================================
