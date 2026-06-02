---
name: vo2-agent-skills
description: VO2 Agent Skill Directory — CatalogAgent (112 skills) and ManagerAgent (122 skills). Use this to look up available skills by name, type, and limitations.
---

# VO2 Agent Skill Directory
SkillsVersion: 8.4.0 | Generated: 2026-06-01

Tento soubor je autoritativní seznam skills pro dva typy agentů:
- **CatalogAgent** (CatalogPrompt) — 111 skills
- **ManagerAgent** (ManagerPrompt) — 121 skills

## PRAVIDLA POUŽITÍ SKILLS
- Pokud skill pokrývá úkol: použít skill, má přednost před obecným workflow
- Pokud skill odporuje canonical governance: canonical governance má přednost
- Uvést `SkillsUsed[]` v run reportu
- Skill NENÍ v tomto Skill Directory: ZABLOKOVAT použití, reportovat `skill_blocked`
- Pokud úkol není pokryt žádným skill: navrhnout nový skill, reportovat jako `capability_missing`

---

# A. DB & SCHEMA

## db-schema-guardian
**For:** Catalog + Manager | Schema governance, tabulky, sloupce, indexy, BaseGuid, migrace
Autoritativní správce DB schématu. Zajišťuje povinné sloupce (Guid, CreatedAt, UpdatedAt, Emoji, Colors, scoring), správné indexy, FK ve formátu SomethingGuid, BaseGuid pro multi-type entity.
*Limitations: nespouští migrace automaticky — vždy vyžaduje potvrzení operátora*

## db-migration-validator
**For:** Catalog + Manager | Validace SQL migrací, safety check před spuštěním
Analyzuje migration skripty. Detekuje destruktivní operace (DROP, TRUNCATE, ALTER bez NULL default).
*Limitations: nenahrazuje testování na dev DB*

## db-null-audit
**For:** Catalog + Manager | NULL analýza, datová kvalita, prioritizace backfillu
Skenuje tabulky, reportuje NULL hodnoty per sloupec seřazené dle NULL ratio DESC.
*Limitations: max 200 tabulek na run*

## db-index-optimizer
**For:** Catalog + Manager | Indexy, výkon, missing/redundant indexes
Identifikuje chybějící indexy na FK a filter sloupcích. Navrhuje CREATE/DROP INDEX.
*Limitations: navrhuje pouze, nespouští — DBA potvrzení povinné*

## db-constraint-checker
**For:** Catalog + Manager | FK, unique, check constraints
Validuje FK, UNIQUE a CHECK constraints. Reportuje porušení a osiřelé FK záznamy.
*Limitations: pouze čte; neopravuje data automaticky*

## db-table-health-monitor
**For:** Catalog + Manager | Monitoring tabulek, row counts, freshness, bloat
Monitoruje zdraví tabulek: row counts, datum posledního UpdatedAt, bloat. Flaguje stale tabulky.
*Limitations: bloat estimate přibližný bez VACUUM ANALYZE*

## db-column-score-auditor
**For:** Catalog + Manager | Scoring sloupce, ConfidenceScore, ReliabilityScore, QualityScore
Ověřuje, že scoring sloupce jsou populovány. Reportuje NULL violations per tabulka.
*Limitations: max 100 oprav na run*

## db-foreign-key-resolver
**For:** Catalog + Manager | Dangling FK, osiřelé záznamy, referenční integrita
Hledá FK sloupce odkazující na neexistující parent záznamy. Navrhuje opravu nebo soft-delete.
*Limitations: neopravuje automaticky; vždy vyžaduje review*

## db-view-dependency-tracker
**For:** Catalog only | View dependencies, schema změny, bezpečné migrace
Mapuje závislosti analytických views. Před schema změnou ověří dotčené views.
*Limitations: neanalyzuje dynamické SQL ani stored procedures*

---

# B. ENTITY & IDENTITY

## match-upsert-guardian
**For:** Catalog + Manager | Identity validace, matching, safe upsert entit
Bezpečný upsert s multi-step matching (exact → alias → token 80% → ExternalID → manual queue).
*Limitations: při nejednoznačném matchování posílá do ManualReviewQueue, nezapisuje*

## shared-entity-normalizer
**For:** Catalog only | Deduplikace, normalizace sdílených entit
Detekuje a slučuje duplicitní záznamy. Udržuje NormalizedName v sync. Canonical merge s audit trail.
*Limitations: fyzické mazání zakázáno — vždy soft-delete s IsDeleted=true*

## entity-lifecycle-manager
**For:** Catalog only | Stav entity, archivace, reaktivace, lifecycle transitions
Spravuje lifecycle: active → archived → deleted. Enforces soft-delete policy. Loguje přechody.
*Limitations: přechod deleted → active vyžaduje manuální potvrzení operátora*

## entity-alias-registry
**For:** Catalog + Manager | Aliasy, alternativní jména, alias lookup
Udržuje tabulku aliasů. Přidává nové varianty jmen, jazykové mutace, historické názvy.
*Limitations: max 50 aliasů per entita*

## entity-external-id-mapper
**For:** Catalog only | ExternalID, Wikidata, IMDB, TMDB, cross-referencing
Mapuje ExternalID z externích systémů na interní Guidy. Obousměrný index.
*Limitations: jeden ExternalID per source system per entita*

## entity-confidence-scorer
**For:** Catalog only | ConfidenceScore výpočet, datová kvalita
Vypočítává ConfidenceScore (0-100) z počtu zdrojů, čerstvosti, cross-source shody (±30%).
*Limitations: min 1 zdroj pro výpočet; bez zdroje nastavuje 0*

## entity-merge-coordinator
**For:** Catalog only | Merge entit, FK přesměrování, merge audit
Orchestruje merge duplicitních entit. Přesměruje FK na canonical. Soft-deletuje sloučené.
*Limitations: max 10 entit na merge operaci*

## entity-soft-delete-manager
**For:** Catalog only | Soft-delete, IsDeleted, archivace bez fyzického mazání
Aplikuje soft-delete (IsDeleted=true, DeletedAt=now()). Zaznamenává důvod smazání.
*Limitations: nelze na záznamy s aktivními FK dependencemi bez cascade flag*

## entity-quarantine-handler
**For:** Catalog only | Karanténa, podezřelá data, ManualReviewQueue
Přesouvá podezřelé záznamy do QuarantineQueue. Používá při nízké důvěryhodnosti zdroje.
*Limitations: max 200 v queue*

## entity-discovery-agent
**For:** Catalog only | Discovery, nové entity, DiscoveryQueue, max 50/run
Vyhledává nové entity. Deduplicates before insert. Max 50 nových entit per run.
*Limitations: max 50 nových entit/run; vždy dedup před zápisem do DB*

## entity-canonical-validator
**For:** Catalog only | Canonical validace, povinné sloupce, Guid UUID v4
Validuje Guid format (UUID v4), povinné sloupce (CreatedAt, UpdatedAt, IsDeleted, NormalizedName).
*Limitations: pouze validuje; neopravuje záznamy automaticky*

## entity-relation-mapper
**For:** Catalog only | Entity relace, FK graf, konzistence vztahů
Buduje graph relací. Ověřuje FK konzistenci. Detekuje chybějící nebo nesprávné vztahy.
*Limitations: max hloubka 3 stupně; cyklické grafy přerušuje*

## external-id-mapper
**For:** Manager only | ExternalID, Flashscore ID, Sofascore ID, cross-referencing
Mapuje ExternalID ze sportovních zdrojů (Flashscore, Sofascore, WhoScored) na interní Guidy.
*Limitations: jeden ExternalID per source system per entita*

---

# C. DATA COLLECTION

## web-scraper-coordinator
**For:** Catalog only | Web scraping, multi-source, rate limiting, robots.txt
Koordinuje scraping. Respektuje rate limit (1 req/s), robots.txt a circuit breaker stav.
*Limitations: nescrapuje za login walls bez explicitního auth config*

## api-rate-limiter
**For:** Catalog only | API rate limiting, quota management, request queuing
Enforces rate limits (max 5 req/s API, max 1 req/s scraping, max 500 req/run).
*Limitations: quota counter se resetuje o půlnoci UTC*

## pagination-cursor-manager
**For:** Catalog only | Pagination, cursor management, incremental scraping
Ukládá a obnovuje pagination cursory mezi runy. Brání re-scrapingu zpracovaných dat.
*Limitations: cursor platnost max 30 dní*

## source-circuit-breaker-manager
**For:** Catalog only | Circuit breaker, open/half_open/closed, source availability
Spravuje circuit breaker stavy per source. Otevírá po 3 failures; testuje half_open po 30 min.
*Limitations: reset pouze manuálně nebo po úspěchu*

## source-reliability-tracker
**For:** Catalog + Manager | Spolehlivost zdrojů, SourceReliability, ReliabilityScore
Sleduje success/failure ratio per zdroj. Aktualizuje ReliabilityScore (0-100).
*Limitations: min 10 requestů pro výpočet ReliabilityScore*

## wikipedia-entity-harvester
**For:** Catalog only | Wikipedia, Wikidata API, entity enrichment
Sbírá entity data z Wikipedia a Wikidata. Mapuje na DB schema.
*Limitations: max 50 Wikidata API calls/run*

## rss-feed-processor
**For:** Catalog only | RSS, Atom feeds, news harvesting
Zpracovává RSS/Atom feeds. Deduplikuje záznamy dle GUID/link.
*Limitations: max 500 items per feed per run*

## json-api-collector
**For:** Catalog only | REST API, GraphQL, JSON response mapping, auth
Volá REST/GraphQL API s auth (Bearer/API key/OAuth). Mapuje JSON response na DB schema.
*Limitations: max 5 req/s*

## html-table-parser
**For:** Catalog only | HTML tabulky, web scraping, structured data extraction
Parsuje HTML tabulky. Mapuje sloupce na DB fields dle header nebo positional mapping.
*Limitations: max 10 000 řádků per tabulka*

## search-engine-harvester
**For:** Catalog only | Search API, snippets, entity discovery
Používá search engine API pro discovery entity URL a strukturovaných snippetů.
*Limitations: max 100 search requests/run; bez API key nelze použít*

## flashscore-match-harvester
**For:** Manager only | Sběr zápasů z Flashscore-like zdrojů, live score pages
Specializovaný harvester pro výsledkové weby. Parsuje výsledky, datum, týmy, skóre, status.
Rate limiting (1 req/s), circuit breaker, max 100 nových zápasů/datum, max 25 dotazů/datum.
*Limitations: pouze historické zápasy (včera a starší); dnešní a budoucí PŘESKOČIT*

## anti-bot-fallback-handler
**For:** Manager only | Anti-bot detekce, 403/429/503, fallback zdroj
Detekuje anti-bot signály. Přepíná na secondary → tertiary zdroj. Nikdy neobchází CAPTCHA.
*Limitations: neretryuje blokovanou URL více než 2× za run*

---

# D. DATA VALIDATION

## data-range-validator
**For:** Catalog only | Numerické rozsahy, anomaly detection, range checks
Validuje numerické hodnoty vůči přijatelným rozsahům (věk 0-120, skóre 0-100, lat/lng...).
*Limitations: pravidla musí být definována; neodhaduje pravidla automaticky*

## referential-integrity-checker
**For:** Catalog only | Referenční integrita, FK validace, parent existence
Ověřuje, že FK sloupce odkazují na existující parent záznamy.
*Limitations: pouze čte; nevytváří ani nemaže záznamy*

## format-validator
**For:** Catalog only | Formáty, datum ISO 8601, email, URL, telefon E.164, UUID v4
Validuje formáty polí. Quarantinuje záznamy s neplatnými formáty.
*Limitations: UUID validace pouze format, ne existence v DB*

## duplicate-detector
**For:** Catalog only | Detekce duplikátů, exact/fuzzy match, merge kandidáti
Detekuje potenciální duplikáty: exact match (NormalizedName) a fuzzy match (token 80%).
*Limitations: max 1000 párů per run*

## cross-source-verifier
**For:** Catalog + Manager | Cross-source validace, diskrepance, source agreement
Porovnává hodnoty polí napříč různými zdroji. Flaguje diskrepance > 30% nebo exact mismatch.
*Limitations: min 2 zdroje pro verifikaci*

## temporal-consistency-checker
**For:** Catalog only | Časová konzistence, datum logika, ordering
Ověřuje: CreatedAt ≤ UpdatedAt, start_date ≤ end_date, birth_date < death_date.
*Limitations: neřeší timezone konverze automaticky — vše v UTC*

## geo-data-validator
**For:** Catalog only | GPS souřadnice, geografie, country/city konzistence
Validuje lat/lng rozsahy, konzistenci country/city, formát ISO 3166 country codes.
*Limitations: reverse geocode pouze pokud Nominatim API dostupné*

## name-format-validator
**For:** Catalog only | Jména, NormalizedName, encoding, speciální znaky
Validuje formát jmen: NormalizedName (lowercase, trim, unicode NFC). Detekuje problematické znaky.
*Limitations: jazykové specifika (arabština, čínština) vyžadují locale config*

## score-boundary-validator
**For:** Catalog only | Score hodnoty, ConfidenceScore, 0-100 range, NULL check
Ověřuje, že Score sloupce jsou v rozsahu 0-100 a nejsou NULL.
*Limitations: neopravuje hodnoty bez explicitního potvrzení*

## schema-compliance-checker
**For:** Catalog only | Schema compliance, povinné sloupce, CatalogPrompt standard
Ověřuje, zda tabulky splňují schema standard (Guid, CreatedAt, UpdatedAt, IsDeleted, ConfidenceScore...).
*Limitations: pouze struktura*

## match-result-validator
**For:** Manager only | Validace výsledků, score consistency, anomaly detection
Validuje HomeScore/AwayScore (0-30 standard), flag pro >15 gólů, konzistence s MatchEvents.
*Limitations: flag pouze informativní; manual review queue pro anomálie*

## match-score-anomaly-checker
**For:** Manager only | Score anomálie, high score flag, manual review
Flaguje zápasy se skóre > 15. Vytváří ManualReviewQueue záznam.
*Limitations: threshold 15 konfigurovatelný; flag nezastavuje zápis*

---

# E. DEDUPLICATION & NORMALIZATION

## relationship-backfill-enricher
**For:** Catalog + Manager | Backfill chybějících relací, FK enrichment
Doplňuje chybějící FK vazby. Pořadí: NULL first (IS NULL DESC), pak nejstarší UpdatedAt ASC.
*Limitations: max 100 záznamů na tabulku na run*

## token-matching-engine
**For:** Catalog only | Fuzzy matching, token similarity, 80% threshold
Token-based fuzzy matching na 80% threshold. Jaccard similarity. Top-3 kandidáti.
*Limitations: max 500ms per query*

## alias-resolution-service
**For:** Catalog only | Alias lookup, canonical Guid resolution
Překládá alternativní jména na canonical Guid: exact → normalized → partial alias.
*Limitations: při ambiguitě posílá do ManualReviewQueue*

## normalized-name-sync
**For:** Catalog only | NormalizedName synchronizace, unicode NFC, lowercase
Udržuje NormalizedName v synchronizaci s Name (lowercase, trim, unicode NFC).
*Limitations: NormalizedName nesmí být NULL*

## external-id-consolidator
**For:** Catalog only | ExternalID deduplikace, source system consolidation
Slučuje duplicitní ExternalID záznamy. Zachovává historii v Metadata.
*Limitations: jeden canonical ExternalID per source per entita*

## merge-conflict-resolver
**For:** Catalog only | Merge konflikty, field-level resolution
Detekuje a řeší field-level konflikty při entity merge dle confidence score a čerstvosti.
*Limitations: manual strategy vždy vyžaduje operátorský input*

## canonical-record-maintainer
**For:** Catalog only | Canonical záznam, IsCanonical flag, duplicate management
Zajišťuje právě JEDEN canonical=true záznam per entitu.
*Limitations: při nejasnosti posílá do ManualReviewQueue*

## dedup-audit-logger
**For:** Catalog only | Audit trail deduplikace, merge log, rollback info
Loguje všechny deduplication a merge akce do AuditLog s before/after state.
*Limitations: rollback guidance je informativní — nespouští se automaticky*

---

# F. ENRICHMENT & BACKFILL

## null-field-enricher
**For:** Catalog + Manager | Doplnění NULL hodnot, prioritizovaný backfill
Identifikuje NULL hodnoty ve vysoko-prioritních sloupcích a doplňuje ze zdrojů.
*Limitations: max 100 per tabulka per run; neopravuje hodnotou NULL*

## confidence-decay-manager
**For:** Catalog + Manager | Confidence decay, -5 bodů / 30 dní, stale data
Aplikuje -5 ConfidenceScore za každých 30 dní bez ověření. Min = 10.
*Limitations: decay pouze na záznamy starší 30 dní bez UpdatedAt update*

## metadata-enricher
**For:** Catalog only | Metadata JSONB enrichment, additive merge
Obohacuje Metadata JSONB. Nikdy nepřepisuje existující klíče; pouze přidává nové.
*Limitations: max 100 KB Metadata per záznam*

## geo-enricher
**For:** Catalog only | GPS souřadnice, timezone, country code
Přidává geografická data: lat/lng (Nominatim), country code (ISO 3166), timezone.
*Limitations: Nominatim rate limit 1 req/s*

## date-enricher
**For:** Catalog only | Neúplné datumy, year-only → full date, date resolution
Resolvuje neúplné datumy ze sekundárních zdrojů. Přidává date_precision do Metadata.
*Limitations: neguessuje datumy bez zdroje*

## image-enricher
**For:** Catalog only | Obrázky pro entity bez ImageGuid, image discovery
Hledá obrázky pro entity bez ImageGuid z Wikipedia Commons a schválených zdrojů.
*Limitations: pouze z whitelisted zdrojů; vždy ověří copyright*

## classification-enricher
**For:** Catalog only | Kategorizace, taxonomy, entity classification
Přiřazuje category/type klasifikace z taxonomy. Confidence < 60% → ManualReviewQueue.
*Limitations: confidence < 60% → posílá do ManualReviewQueue*

## relationship-enricher
**For:** Catalog only | Vztahy mezi entitami, chybějící relace, FK discovery
Objevuje a vytváří chybějící relace (PersonOrganization, VenueOrganization...).
*Limitations: nevytváří vztahy s ConfidenceScore < 60% bez review*

## source-attribution-enricher
**For:** Catalog only | Source attribution, SourceName, SourceUrl, SourceDate
Doplňuje chybějící source attribution k záznamům s NULL attribution.
*Limitations: bez dohledatelného zdroje ponechá NULL*

---

# G. RUN ORCHESTRATION

## archival-run-orchestrator
**For:** Catalog only | Run orchestration, shortest-safe-path, plánování kroků
Orchestruje scheduled run po nejkratší bezpečné cestě. Time-budget governance (8 min / 15 min manual).
*Limitations: nenahrazuje domain-specific logiku sběru dat*

## archival-scope-optimizer
**For:** Catalog only | Scope optimization, highest-value safe scope, prioritizace
Optimalizuje rozsah runu pro maximální hodnotu v rámci time budgetu.
*Limitations: neprovádí samotný sběr dat*

## time-budget-governor
**For:** Catalog + Manager | Time budget, graceful stop, run timeout
Sleduje zbývající time budget (8 min scheduled / 15 min manual). Graceful stop při 80%.
*Limitations: nezastavuje násilně běžící DB operace*

## parallel-task-coordinator
**For:** Catalog only | Paralelizace, nezávislé úkoly, concurrency management
Identifikuje úkoly bez závislostí pro paralelní spuštění. Max 3 paralelní operace.
*Limitations: DB write operace vždy sekvenčně*

## dependency-resolver
**For:** Catalog only | Závislosti mezi tabulkami, FK pořadí, topologické třídění
Určuje správné pořadí zpracování tabulek dle FK závislostí. Parent tabulky vždy dřív.
*Limitations: cyklické závislosti reportuje jako BLOCKER*

## run-checkpoint-manager
**For:** Catalog + Manager | Checkpoints, resume after interruption, run state
Ukládá stav runu na checkpointech. Umožňuje pokračování po přerušení.
*Limitations: checkpoints do AgentRunReports Metadata; max 24h platnost*

## missed-run-catchup-handler
**For:** Catalog + Manager | Missed run, catch-up mode, gap detection
Detekuje výpadky runů. Gap > 2x interval → catch-up mode (max 3 dny zpět).
*Limitations: max 3 dny zpět*

## circuit-breaker-coordinator
**For:** Catalog + Manager | Circuit breaker evaluation, run start check
Evaluuje stav všech circuit breakerů na začátku runu.
*Limitations: nerestartuje circuit breakery; pouze evaluuje stav*

## tier1-pipeline-executor
**For:** Manager only | Tier1 kroky, okamžité post-match, scores/events/standings
Exekuuje Tier1 post-match pipeline okamžitě: HomeScore/AwayScore/Status, MatchEvents, Standings.
*Limitations: Tier1 NIKDY přeskočit*

## tier2-pipeline-scheduler
**For:** Manager only | Tier2 kroky, do 24h, attendance/stats/lineups/odds
Plánuje Tier2 kroky (do 24h po zápase): Attendance, MatchStats, MatchLineups, MatchOdds.
*Limitations: Tier2 lze přeskočit v fallback módu; odložit max na 48h*

## tier3-pipeline-planner
**For:** Manager only | Tier3 kroky, do 7 dní, ratings/H2H/form
Plánuje Tier3 kroky (do 7 dní): player ratings, H2H update, TeamForm + PlayerForm.
*Limitations: Tier3 lze odložit nebo přeskočit v degraded módu*

---

# H. REPORTING & AUDIT

## scheduled-run-report-formatter
**For:** Catalog + Manager | Finální run report, formátování výstupu
Generuje strukturovaný run report. Catalog: startup, discovery, collection, errors, SkillsUsed.
Manager: startup, zpracované zápasy per datum, Post-Match Pipeline (Krok 1-11).
*Limitations: report musí být uložen i při selhání runu*

## audit-log-writer
**For:** Catalog + Manager | AuditLog, change tracking, before/after state
Zapisuje do AuditLog: actor, action, EntityGuid, table, before, after, timestamp.
*Limitations: before/after max 10 KB per záznam*

## error-classification-reporter
**For:** Catalog only | Error klasifikace, Tier1/2/3, retry strategie
Klasifikuje chyby: Tier1 (retry), Tier2 (fallback), Tier3 (skip + ntfy).
*Limitations: nerozlišuje transient vs persistent errors bez retry history*

## data-quality-reporter
**For:** Catalog only | Datová kvalita, NULL ratio, score distribuce, stale records
Generuje zprávu o kvalitě dat: NULL ratio, distribuce ConfidenceScore, stale záznamy.
*Limitations: max 50 tabulek na reportovací run*

## coverage-gap-reporter
**For:** Catalog only | Coverage gaps, chybějící data, priority enrichment list
Identifikuje entity s chybějícími daty pro high-Score tabulky (Score 80+).
*Limitations: max 200 entit v priority listu*

## compliance-audit-generator
**For:** Catalog + Manager | Governance compliance, schema standard, soft-delete audit
Generuje compliance report vůči governance: schema standard, soft-delete policy, scoring columns.
*Limitations: detekuje pouze porušení trackovatelná v DB*

## delta-change-reporter
**For:** Catalog only | Delta report, inserted/updated/deleted, run comparison
Porovnává aktuální run s předchozím. Identifikuje neočekávané změny (spike/drop > 50%).
*Limitations: vyžaduje AgentRunReports z předchozího runu*

## agent-health-reporter
**For:** Catalog only | Agent health, DB latency, source availability, error rates
Reportuje health metriky: DB response time, source availability %, error rate, run duration (7 dní).
*Limitations: data pouze z AgentRunReports*

## run-status-broadcaster
**For:** Catalog + Manager | Run status, agent-runs kanál, completion summary
Na konci runu odešle standardizovanou zprávu na agent-runs kanál.
Catalog: `[AgentName] [OK/WARN/ERROR] | inserted:N updated:N | duration:Xs`
Manager: `[AgentName] [OK/WARN/ERROR] | zápasy:N | Tier1:OK | duration:Xs`
*Limitations: jedna zpráva per run; v limitu 3 ntfy/run*

## matchday-summary-generator
**For:** Manager only | Matchday summary, souhrn kola, ntfy zpráva
Generuje souhrn po zpracování všech zápasů matchday kola. Posílá na ntfy.
*Limitations: jedna zpráva per matchday*

---

# I. FALLBACK & RESILIENCE

## fallback-run-auditor
**For:** Catalog + Manager | Fallback-mode evaluace, degraded run assessment
Vyhodnocuje run v degraded módu. Rozhoduje, které kroky lze přeskočit.
*Limitations: nelze pokud DB zcela nedostupná (db_unreachable = STOP)*

## retry-strategy-executor
**For:** Catalog only | Retry, exponential backoff, Tier1 errors
Exponential backoff retry pro Tier1: max 3 pokusy (2s, 4s, 8s). Po 3 neúspěších eskaluje na Tier2.
*Limitations: neretryuje Tier2 a Tier3 chyby*

## graceful-degradation-handler
**For:** Catalog only | Graceful degradation, reduced scope, minimum viable run
Snižuje scope při resource constraints. Zachovává: Tier1 + run report. Odkládá Tier2/3.
*Limitations: nemůže odložit Tier1 ani upsert_record("AgentRunReports")*

## error-escalation-manager
**For:** Catalog + Manager | Error escalation, ntfy agent-errors, Tier3 errors
Eskaluje Tier3 chyby na ntfy agent-errors. Max 3 ntfy per run.
*Limitations: max 3 ntfy per run; překročení agreguje do jedné souhrnné zprávy*

## source-failover-coordinator
**For:** Catalog only | Source failover, backup zdroj, primary circuit open
Přepíná na backup zdroj při otevřeném circuit breakeru primárního zdroje.
*Limitations: backup musí být předem nakonfigurován v Metadata*

## sheet-fallback-mapper
**For:** Catalog + Manager | Export do Google Sheets, fallback při nedostupnosti DB
Exportuje data do Google Sheets jako fallback zálohu při nedostupnosti DB.
*Limitations: pouze fallback — pokud DB dostupná, vždy preferovat přímý zápis do DB*

## data-integrity-recovery
**For:** Catalog only | Oprava integrity violations, auto-fix safe mode
Detekuje a opravuje integrity violations: missing Guids, invalid formats, broken FK. Loguje do AuditLog.
*Limitations: safe mode pouze non-destructive; aggressive vyžaduje potvrzení operátora*

---

# J. SCHEDULING & CALENDAR

## next-run-calendar-scheduler
**For:** Catalog + Manager | Plánování příštího runu v Google Calendar
Catalog: vytváří event v kalendáři "AI Catalogs". Manager: v kalendáři "AI Managers".
Před vytvořením: list_events → smazat starý event → vytvořit nový. Při úspěchu suffix " ✅", selhání " ❌".
*Limitations: nemaže historické eventy (jen budoucí duplicity)*

## run-interval-calculator
**For:** Catalog only | Interval výpočtu, freshness SLA, next run time
Score ≥ 90 = max 24h, ≥ 70 = max 48h.
*Limitations: nezohledňuje external events*

## maintenance-window-planner
**For:** Catalog only | Maintenance window, schema migrations, bulk backfill scheduling
Plánuje maintenance runs do oken s nízkým provozem (typicky 02:00-05:00 Prague TZ).
*Limitations: nezná real-time server load*

## timezone-aware-scheduler
**For:** Catalog only | Timezone konverze, DST, Europe/Prague TZ
Konvertuje všechny scheduled times do Europe/Prague TZ. Respektuje DST přechody.
*Limitations: primárně pro Europe/Prague*

## calendar-conflict-resolver
**For:** Catalog only | Calendar konflikty, duplicate events, AI Catalogs cleanup
Detekuje duplicitní Calendar eventy. Zajišťuje právě JEDNU budoucí událost per agent.
*Limitations: neupravuje eventy jiných agentů*

## international-calendar-manager
**For:** Manager only | InternationalCalendar, FIFA/UEFA přestávky, scheduling
Spravuje InternationalCalendar záznamy. Při aktivní přestávce: ligové zápasy nepočítá.
*Limitations: bez konfigurace nelze detekovat*

---

# K. IMAGE & MEDIA

## vo2qnapdb-image-guardian
**For:** Catalog + Manager | Image workflow, SharedImages + EntityImages, QNAP upload
Kompletní image workflow: validace (MIME, velikost, hash), dedup SHA256, upload,
zápis do SharedImages + EntityImages s historizací (IsCurrent, ValidFrom/ValidTo).
Povolené MIME: png, webp, jpeg, svg+xml (bez scriptů). Max 15 MB.
*Limitations: pouze když explicitně vyžadováno*

## image-dedup-checker
**For:** Catalog only | Image deduplikace, SHA256, existing image check
SHA256 hash check před uploadem. Pokud existuje, vrátí existující Guid.
*Limitations: hash z binárních dat; metadata rozdíly nezpůsobují dedup*

## image-format-validator
**For:** Catalog only | MIME validace, image formáty, bezpečnostní check
Validuje MIME type, rozměry, velikost, bezpečnost (SVG bez JS).
*Limitations: max 15 MB; animované GIF nepodporuje*

## image-url-validator
**For:** Catalog only | Validace image URL, HTTP accessibility, MIME check
Ověřuje dostupnost URL, správný MIME type. HTTP HEAD request před plným downloadem.
*Limitations: timeout 5s; neřeší captcha nebo login-gated obrázky*

## entity-image-history-manager
**For:** Catalog only | Image historizace, IsCurrent flag, ValidFrom/ValidTo
Spravuje historii obrázků v EntityImages. Při novém obrázku nastavuje IsCurrent=false na předchozím.
*Limitations: uchovává historii navždy; nemaže staré záznamy*

## club-logo-updater
**For:** Manager only | Logo klubu, Teams.LogoUrl, EntityImages
Vyhledává, validuje a uploaduje logo klubu. Aktualizuje Teams.LogoUrl.
*Limitations: automatický update loga nepovoluje bez souhlasu*

## player-portrait-manager
**For:** Manager only | Fotografie hráče, Players.PhotoUrl, EntityImages
Spravuje portréty hráčů: upload, aktualizace Players.PhotoUrl, historizace.
*Limitations: pouze frontální portrét; group fotografie neakceptuje*

## venue-photo-uploader
**For:** Manager only | Fotografie stadionu, Venues, EntityImages
Uploaduje fotografie stadionů. ImageType: exterior/interior/aerial.
*Limitations: max 5 fotografií per venue*

---

# L. NAMES & URLS (Catalog only)

## names-file-processor
Čte {AgentName}_names.txt z Drive /Names/ (ID: 1-3GkQT-OqVpkaKwLKkgW8jjbWzNN7BYY). Max 10 000 jmen.

## urls-priority-queue-manager
Čte {AgentName}_urls.txt z Drive /Urls/ (ID: 1kYViGZR02wNjr1X0PEqJzBQYmjxobm5U). Max 500 URL.

## url-health-checker
Testuje dostupnost URL. Mrtvé označuje v SourceCircuitBreaker jako open. Max 50 URL per run.

## url-redirect-resolver
Sleduje redirect chainy. Ukládá finální canonical URL. Max 10 redirectů.

## name-variant-generator
Generuje varianty jmen (bez členu, zkratky, překlepy). Max 20 variant per jméno.

## canonical-url-normalizer
Normalizuje URL: lowercase scheme/host, odstranění tracking parametrů (utm_*, fbclid, gclid).

---

# M. NOTIFICATION

## ntfy-notification-sender
**For:** Catalog + Manager | Ntfy notifikace, agent-runs, agent-errors, agent-maintenance
Odesílá notifikace na ntfy.vo2info.cz. Max 3 notifikace per run; překročení → jedna souhrnná.
Kanály: `agent-runs` | `agent-errors` | `agent-maintenance`

## alert-threshold-monitor
**For:** Catalog only | Threshold alerting, metrics monitoring, proactive alerting
Monitoruje metriky vůči thresholdům. NULL ratio > 30%, error rate > 10% → ntfy alert.
*Limitations: max 3 alerty per run*

---

# N. ADVANCED OPERATIONS

## dry-run-mode-controller
**For:** Catalog + Manager | DryRun mode, testovací běh, simulace bez DB zápisů
Blokuje INSERT/UPDATE/DELETE. Simuluje výstupy s "[DRY_RUN]" prefixem.
upsert_record("AgentRunReports") proběhne s IsDryRun=true. Calendar eventy SE NETVOŘÍ.
*Limitations: DB a Drive čtení povoleno; veškeré zápisy blokovány*

## data-export-backup-manager
**For:** Catalog only | Export, backup, JSON Lines, Drive /Prompts/Backups/
Týdně Score≥70 tabulky, měsíčně full export. Formát JSON Lines (.jsonl), gzip pro >1MB.
*Limitations: max 10 000 řádků per tabulka*

## baseline-catalog-file-manager
**For:** Catalog only | Baseline catalog, Drive /Prompts/Catalogs/
Čte a aktualizuje {AgentName}.txt v Drive /Prompts/Catalogs/ (ID: 1XDM5t9uh6Aea7FEAL9IOsFUMV7pEdYgi).
*Limitations: DryRun = nezapisuje*

## manager-baseline-file-manager
**For:** Manager only | Baseline soubor agenta, Drive /Prompts/Managers/
Čte a aktualizuje {AgentName}.txt v Drive /Prompts/Managers/ (ID: 1lEvffJ-rjdExCwMWxmWM7PchnKkGTGUO).
Formát: `Score | TableName | Description | RowCount | LastPopulated`
*Limitations: DryRun = nezapisuje*

## cross-agent-task-writer
**For:** Catalog + Manager | Cross-agent zápis, Names/Urls soubory, task assignment
Zapisuje úkoly pro jiné agenty do jejich Names/Urls souborů na Drive (append-only).
Max 50 položek per zápis; soubor max 500 řádků. Zaznamenává v highlights[].
*Limitations: NIKDY nepřepisuje celý soubor*

## weekly-digest-reporter
**For:** Catalog + Manager | Weekly/monthly digest, souhrnný report, Drive /Prompts/Reports/
Generuje týdenní (každých 7 runů nebo každé pondělí) a měsíční digest.
Catalog: inserted/updated/failed, stale tabulky, backfill progress.
Manager: zpracované zápasy, coverage progress, cross-agent tasks.
*Limitations: min 3-5 runů pro smysluplný digest*

## agent-schedule-manager
**For:** Catalog + Manager | AgentSchedules, denní čas spuštění, detekce konfliktů
UPSERT (AgentName, ScheduledRunTime, NextRunAt, LastRunAt) na konci každého runu.
Startup: načte přehled agentů, detekuje konflikty (±15 min).
*Limitations: NEZDVOJIT upsert při DryRun*

## sport-date-coverage-manager
**For:** Manager only | SportDateCoverage, exhausted datumy, znovuotevření, verification
Označuje datumy jako exhausted (po 5 runech + 2 nezávislé zdroje). Automaticky znovu otevírá po 1 roce.
*Limitations: vcerejsek NIKDY neoznačovat jako exhausted*

## match-preview-generator
**For:** Manager only | Match Preview, H2H, forma, nedostupní hráči
Generuje pre-match preview ze 100% historických DB dat: H2H (5 zápasů), forma (last 5+10),
nedostupní hráči, standings, odds trendy. Výstup jako ntfy nebo Calendar description.
*Limitations: max 24h před zápasem; NIKDY nescrapuje live/pre-match data*

## player-career-manager
**For:** Manager only | PlayerCareer, kariéra hráče, angažmá napříč kluby
Spravuje PlayerCareer: jedno angažmá = jeden řádek. JoinedDate, LeftDate, IsCurrentClub.
Agreguje AppearancesTotal, GoalsScored, Assists z PlayerSeasonStats.
*Limitations: max 1 IsCurrentClub=true per PlayerGuid*

---

# O. MATCH CORE (Manager only)

## match-status-tracker
Lifecycle: scheduled → live → finished → cancelled/postponed. Validuje přechody.

## match-duplicate-detector
Detekuje duplikáty: stejný HomeTeam + AwayTeam + MatchDate + Competition.

## match-date-resolver
Resolvuje datum zápasu. Konvertuje na StartTimeUtc. Ověřuje ≤ včerejšek (Prague TZ).

## match-event-bulk-inserter
Bulk insert MatchEvents (góly, karty, střídání). Substitution = 2 záznamy. Max 100 eventů.

## match-lineups-processor
Zpracovává sestavy a lavičky. Validuje počty (max 11 XI, max 12 lavička).

## match-stats-aggregator
Agreguje MatchStats: possession, shots, corners, xG, passes. 2 záznamy per zápas.

## match-odds-recorder
Ukládá pre-match odds (1X2, Over/Under). Opening + closing. Implied probability.
*Limitations: pouze pre-match odds; max 5 bookmakerů per zápas*

## match-coverage-auditor
Audituje completeness post-match dat (Tier1/2/3). Priority list pro doplnění.

## match-postponement-handler
Zpracovává odložení/zrušení: Status=postponed/cancelled, OriginalDate, Reason.
Náhradní zápas = NOVÝ Matches záznam s RescheduledFromMatchGuid. NESMAZAT původní.

---

# P. COMPETITION & SEASON (Manager only)

## season-lifecycle-manager
Detekuje začátek/konec sezóny. IsActive flag. Archivuje Season při ukončení.

## competition-hierarchy-mapper
Hierarchie soutěží: national league → division → group. ParentCompetitionGuid.

## season-date-validator
Validuje: StartDate < EndDate, zápasy v rozmezí sezóny.

## group-stage-coordinator
Skupinová fáze: přiřazení týmů, standings per skupina, postup do knockout.

## knockout-phase-tracker
Knockout fáze: páry, výsledky, postupující. Bracket od čtvrtfinále po finále.

## promotion-relegation-handler
Nastavuje promoted/relegated/playoff flags na Standings po skončení sezóny.

## tiebreaker-rule-loader
Načítá pravidla z Competition.TiebreakerJson. Body → GD → GF → H2H → žluté karty → los.

## season-squad-validator
Validuje squad changes dle Transfer Window (IsCurrentlyOpen). Blokuje při uzavřeném okně.

## competition-coverage-tracker
Porovnává očekávané vs skutečné zápasy per round. Identifikuje chybějící matchday data.

---

# Q. TEAMS & PLAYERS (Manager only)

## squad-update-guardian
Bezpečně aktualizuje Squad záznamy. Respektuje Transfer Window. Loguje do AuditLog.

## player-transfer-processor
Zpracovává přestupy: Transfers záznam + Squads aktualizace (oba týmy).

## player-availability-tracker
PlayerUnavailability: zranění/suspenze/nemoc. Trackuje expected return date.

## player-suspension-checker
Akumulované disciplinární body. Suspend flag při thresholdu (default 5 YC).

## team-formation-recorder
Taktické formace per zápas do MatchLineups.Formation. Validní formace (součet = 10 outfield).

## player-position-normalizer
Normalizuje pozice na canonical kódy: GK, DEF, MID, FWD; CB, LB, RB, CDM, CAM, LW, RW, ST.

## player-nationality-resolver
Resolvuje národnost na ISO 3166-1 alpha-2. Max 2 národnosti per hráč.

## player-age-calculator
Vypočítává věk hráče k datu zápasu. Ukládá age_at_match do MatchLineups.Metadata.

## player-career-stats-aggregator
Agreguje PlayerSeasonStats: góly, asistence, minuty, cards. Per-90 metriky.

## team-venue-association
Asociuje tým s domácím stadionem. Teams.HomeVenueGuid. Historické změny do Metadata.

## coach-assignment-tracker
Trackuje přiřazení trenérů. Teams.HeadCoachGuid. Datum nástupu/odchodu do Metadata.

---

# R. STANDINGS & STATS (Manager only)

## standings-calculator
Přepočítává ligové tabulky. Tiebreaker dle Competition.TiebreakerJson.

## player-form-tracker
Rolling forma (last 5 + 10 zápasů). TeamForm: W/D/L, body/zápas, TrendScore.

## top-scorer-tracker
Tabulka střelců per Competition + Season. Z MatchEvents (goal, excludes OG).

## clean-sheet-tracker
Clean sheets per brankář/tým. 0 obdržených gólů za celý zápas.

## possession-stats-recorder
Possession (home + away must = 100%). Tolerance ±1%.

## xg-data-processor
xG ze zdrojů. Team xG → MatchStats, player xG → MatchEvents/PlayerSeasonStats.

## disciplinary-stats-aggregator
YC/RC per hráč per sezóna. PlayerDiscipline. Volá player-suspension-checker.

## head-to-head-updater
HeadToHead záznamy po každém zápase. W/D/L, góly, posledních 5 setkání, H/A split.

## assists-leaderboard-updater
Tabulka asistentů per Competition + Season. Z MatchEvents (EventType = assist).

---

# S. ODDS & INTEGRITY (Manager only)

## odds-integrity-monitor
Pohyb odds > 20% → integrity flag + ManualReviewQueue. Implied probability per zápas.

## implied-probability-calculator
Implied probability z kurzů (1/odds normalizovaná na 100%). Overround %. Fair odds.

## line-movement-tracker
Historie pohybu kurzů. Pohyb > 20% = sharp money signal.

## bookmaker-reliability-scorer
Spolehlivost bookmakerů: dostupnost, přesnost opening odds. ReliabilityScore (0-100).

## integrity-flag-escalator
Eskaluje integrity flags (odds/score anomálie) na ManualReviewQueue + ntfy.

## arbitrage-detector
Detekuje arbitrážní příležitosti: součet reciprokých kurzů < 1.00. Pouze informativní flag.

---

# T. POST-MATCH PIPELINE EXTRAS (Manager only)

## attendance-recorder
Návštěvnost do MatchStats/Matches.Attendance. Validace (0 - max kapacita).

## referee-performance-tracker
Přiřazuje rozhodčí. Trackuje výkon (karty, fauly). Referees záznam.

## var-event-recorder
VAR rozhodnutí jako MatchEvents (EventType = VAR). Typy: goal_disallowed, penalty_awarded...

## extra-time-handler
Výsledky prodloužení. Skóre po 90 min vs po ET. Penalty shootout trigger flag.

## penalty-shootout-recorder
Výsledky PK: pořadí hráčů, proměněné/neproměněné. WinnerTeamGuid dle PK.

## substitution-event-processor
Střídání = 2 MatchEvents: sub_in + sub_out. Aktualizuje MinutesPlayed pro oba hráče.

## injury-time-calculator
Přidaný čas per poločas do Matches.Metadata. Efektivní délka hry.

## match-rating-aggregator
Hodnocení hráčů per zápas (WhoScored, SofaScore). Normalizace na 0-10. Průměr max ze 3 zdrojů.

---

# U. TRANSFER & INJURY (Manager only)

## transfer-window-monitor
Transfer Window IsCurrentlyOpen per competition. Blokuje neoprávněné squad changes.

## transfer-record-processor
Transfers tabulka: permanent, loan, free agent, end of loan. Fee v EUR.

## injury-report-parser
Parsuje zprávy o zraněních. Klasifikuje: muscle/bone/ligament/illness/other.

## unavailability-period-calculator
Délka absence v zápasech (kolik ligových vynechá). MissedMatches count.

## return-date-estimator
Aktualizuje expected return date v PlayerUnavailability. Loguje historii do Metadata.

## suspension-period-calculator
Délka disciplinárního zákazu dle accumulated karet a competition pravidel.

## loan-deal-tracker
Hostování: Transfers (loan) + Squads oba týmy + recall clause. Max 1 aktivní loan per hráč.

## contract-expiry-monitor
Smlouvy expirující do 6 měsíců → free_agent_flag. Z Squads.Metadata.contract_expiry.

---

# V. VIEWS & ANALYTICS (Manager only)

## analytic-views-refresher
Obnovuje analytické views po runu: standings, top_scorers, form_table, H2H summary.

## form-trend-analyzer
Trend formy (improving/stable/declining): last 5 vs předchozích 5 zápasů. TrendScore delta.

## season-statistics-compiler
Celkové statistiky za sezónu: góly, průměr/zápas, H/A split, disciplíny, attendance.

## historical-data-auditor
Audituje historická data per competition/season: completeness, coverage %, missing periods.

## performance-benchmark-tracker
Výkonnostní metriky agenta: zápasů/run, duration, error rate, coverage growth vs baseline.

---

# W. PROBLEM REPORTING (nová sekce — 8.5.0)

## problem-report-writer
**For:** Catalog + Manager | Problem report Drive zápis při selhání, nedokončený run
Zapíše `{AgentName}.txt` do Drive folderId `1w91GGAKnReBc6bWFtrucjlVMYr7NhURj` když:
- `success = false` v run reportu
- NEBO selhal ntfy / Calendar event / upsert_record("AgentRunReports")

**MCP mapping:**
- AIData DB → `VO2QNAPAI`
- TopEleven DB → `VO2QNAPTE`
- MercsAndBeasts DB → `VO2QNAPMAB`
- UniSportManager DB → `VO2QNAPUSM`

**Formát souboru:**
```
Agent:     {AgentName}
MCP:       VO2QNAPAI | VO2QNAPTE | VO2QNAPMAB | VO2QNAPUSM
Timestamp: {ISO datetime}
RunGuid:   {guid}
Version:   {PromptVersion}

PROBLÉMY:
- {popis} [db_error | source_error | pipeline_error | skill_missing | time_budget | other]

NEDOKONČENÉ KROKY:
- ntfy notifikace:      ✅ odesláno | ❌ SELHAL — {důvod}
- Calendar event (✅):  ✅ vytvořen | ❌ SELHAL — {důvod}
- Run report (DB):      ✅ uložen   | ❌ SELHAL — {důvod}
```

*Spouští se PŘED finálním reportem. Best-effort — Drive nedostupný → přeskočit tiše.*

---

*Konec Skill Directory — CatalogAgent: 112 skills | ManagerAgent: 122 skills*

