---
name: vo2-agent-skills
description: VO2 Agent Skill Directory — CatalogAgent (127 skills) and ManagerAgent (126 skills). Use this to look up available skills by name, type, and limitations.
---

# VO2 Agent Skill Directory
SkillsVersion: 10.1.0 | Generated: 2026-07-02

Tento soubor je autoritativní seznam skills pro dva typy agentů:
- **CatalogAgent** (CatalogPrompt) — 127 skills
- **ManagerAgent** (ManagerPrompt) — 126 skills

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
Autoritativní správce DB schématu. Ověřuje ownership tabulky před ALTER TABLE operacemi. Zajišťuje povinné sloupce (Guid, CreatedAt, UpdatedAt, Emoji, Colors, scoring), správné indexy, FK ve formátu SomethingGuid, BaseGuid pro multi-type entity.
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

## source-attribution-tracker
**For:** Catalog only | Source attribution, provenance, data lineage
Reportuje, které zdroje přispěly k jednotlivým záznamům. Generuje attribution matrix: zdroj × tabulka × počet záznamů.
*Limitations: attribution pouze pro záznamy s SourceName ≠ NULL*

## compliance-audit-generator
**For:** Catalog + Manager | Governance compliance, schema standard, soft-delete audit
Generuje compliance report vůči governance: schema standard, soft-delete policy, scoring columns.
*Limitations: detekuje pouze porušení trackovatelná v DB*

## delta-change-reporter
**For:** Catalog only | Delta report, inserted/updated/deleted, run comparison
Porovnává aktuální run s předchozím. Identifikuje neočekávané změny (spike/drop > 50%).
*Limitations: vyžaduje AgentRunReports z předchozího runu*

## baseline-diff-reporter
**For:** Catalog only | Baseline diff, verze baseline katalogu, change summary
Porovnává aktuální baseline catalog s předchozí verzí. Identifikuje přidané, odebrané a změněné entity.
*Limitations: pouze pro entity s Guid; netrackuje field-level změny detailně*

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

## partial-run-recovery
**For:** Catalog only | Obnova přerušeného runu, partial state, checkpoint resume
Obnovuje stav po přerušení runu. Načítá checkpoint z AgentRunReports, identifikuje nedokončené kroky.
*Limitations: checkpoint musí být uložen ≤ 24h zpět; starší nelze obnovit*

## graceful-degradation-handler
**For:** Catalog only | Graceful degradation, reduced scope, minimum viable run
Snižuje scope při resource constraints. Zachovává: Tier1 + run report. Odkládá Tier2/3.
*Limitations: nemůže odložit Tier1 ani upsert_record("AgentRunReports")*

## error-escalation-manager
**For:** Catalog + Manager | Error escalation, ntfy agent-errors, Tier3 errors
Eskaluje Tier3 chyby na ntfy agent-alerts. Max 3 ntfy per run.
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
CALENDAR_ID je pevně nastaven dle AgentType:
- Catalog: "28aae61e20189e8b81c4f903ad431771c6b5517811323e11b12515a9d5dd23da@group.calendar.google.com"
- Manager: "a43e278e3a817484c52c5fc24439845d6aa230c2280ca25eb2a08bae2e5f4eef@group.calendar.google.com"
Před vytvořením: list_events → smazat starý event → vytvořit nový. Při úspěchu suffix " ✅", selhání " ❌".
*Limitations: CALENDAR_ID je hardcoded — list_calendars() není potřeba; nemaže historické eventy*

## run-interval-calculator
**For:** Catalog only | Interval výpočtu, freshness SLA, next run time
ImportantScore >= 90 = max 24h, >= 70 = max 48h.
*Limitations: nezohledňuje external events*

## maintenance-window-planner
**For:** Catalog only | Maintenance window, schema migrations, bulk backfill scheduling
Plánuje maintenance runs do oken s nízkým provozem (typicky 02:00-05:00 Prague TZ).
*Limitations: nezná real-time server load*

## catch-up-scheduler
**For:** Catalog only | Catch-up scheduling, missed runs, multi-day backfill plan
Při detekci missed runs sestavuje catch-up plán pro max 3 dny zpět. Distribuuje zátěž rovnoměrně.
*Limitations: max 3 dny zpět; nenahrazuje data za delší výpadky*

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

## image-metadata-extractor
**For:** Catalog only | EXIF, IPTC, XMP metadata z obrázků
Extrahuje metadata z obrázků: EXIF (datum, GPS, kamera), IPTC (autor, copyright), XMP. Ukládá do SharedImages.Metadata JSONB.
*Limitations: pouze JPEG/TIFF pro EXIF; PNG metadata jsou omezená*

## image-url-validator
**For:** Catalog only | Validace image URL, HTTP accessibility, MIME check
Ověřuje dostupnost URL, správný MIME type. HTTP HEAD request před plným downloadem.
*Limitations: timeout 5s; neřeší captcha nebo login-gated obrázky*

## entity-image-history-manager
**For:** Catalog only | Image historizace, IsCurrent flag, ValidFrom/ValidTo
Spravuje historii obrázků v EntityImages. Při novém obrázku nastavuje IsCurrent=false na předchozím.
*Limitations: uchovává historii navždy; nemaže staré záznamy*

## historical-asset-collector
**For:** Catalog + Manager | Historické loga, historické vlajky, historické cresty, historical timeline
Sbírá VŠECHNY historické verze vizuálních assetů pro entitu — loga, vlajky, erby.
Buduje kompletní timeline od vzniku entity. Každá verze ukládána s from/to metadata a ConfidenceScore.
Primárně z Wikidata P154/P18/P1419, Wikipedia Commons, brandsoftheworld.com, sportslogos.net.
*Limitations: datování může být přibližné (from_circa=true); max 50 historických assetů per run*

## wikidata-image-harvester
**For:** Catalog + Manager | Wikidata P154, P18, P1419, structured image metadata
Dotazuje Wikidata API pro vizuální assety entity — logo (P154), image (P18), coat_of_arms (P1419).
Extrahuje všechny historické verze s přesnými daty redesignů.
*Limitations: vyžaduje WikidataId na entitě; SPARQL timeout pro velké queries*

## image-quality-validator
**For:** Catalog + Manager | Rozlišení, velikost, formát, min quality check
Ověřuje kvalitu obrázku před uložením: min rozlišení (100×100px ikony, 200×200px loga, 500×500px cresty),
preference SVG pro vektorová loga, max 15 MB.
*Limitations: SVG rozlišení nelze měřit jako raster; animované GIF pouze základní check*

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

## kit-timeline-builder
**For:** Manager only | Historické dresy, kit per sezóna, kitsdb.com, historicalkits.co.uk
Sbírá historické dresy (kit_home, kit_away) pro tým per sezóna od ~1970. Ukládá s ValidFrom/ValidTo.
Metadata: {from, to, kit_type, sponsor, colors}.
*Limitations: kitsdb.com pokrývá ~1970+; starší dresy s from_circa=true*

## season-logo-collector
**For:** Manager only | Season logo, season badge, season artwork, per-sezóna branding
Sbírá season-specific loga pro sledované soutěže (UCL, Premier League per sezóna).
EntityType="Seasons", IsCurrent pro probíhající.
*Limitations: starší sezóny mohou mít nižší ConfidenceScore; max 20 sezón per run*

---

# L. NAMES & URLS (Catalog only)

## names-file-processor
Čte tab 'names' z master spreadsheet {AgentName} v Agents složce. Parsuje entity jména do priority queue (Score 90+ first).
Hledání: search_files(query="{AgentName}", folderId="{agentTypeFolderId}") → číst tab 'names'.

## urls-priority-queue-manager
Čte tab 'urls' z master spreadsheet {AgentName} v Agents složce. Seřazuje URL dle ReliabilityScore DESC. Integruje s circuit breaker check.

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
**For:** Catalog + Manager | Ntfy notifikace, agent-runs, agent-errors, agent-alerts, agent-maintenance, agent-digest
Odesílá notifikace na ntfy.vo2info.cz. MCP tool: send_notification — VŽDY z VO2QNAPDB MCP konektoru.
Catalog → VO2QNAPDBAI | Manager/TE → VO2QNAPDBTE | MAB → VO2QNAPDBMAB | USM → VO2QNAPDBUSM.
Max 3 notifikace per run (digest se nepočítá). Jazyk zpráv: česky.
Formát: title max 60 znaků (začíná emoji), message max 200 znaků pipe-separated.
*Limitations: max 3 ntfy per run; překročení agreguje do souhrnné zprávy*

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
**For:** Catalog only | Baseline catalog, master spreadsheet, tab 'entities', bootstrap
Čte a aktualizuje tab 'entities' v master spreadsheet {AgentName} v Agents složce (folder ID: 10AjWPydQjqNKePABVa33GvDZ9JN7xnGd).
Načítá přehled tabulek (ImportantScore, RowCount, LastPopulated) na startu. Aktualizuje na konci runu.
BOOTSTRAP: pokud spreadsheet neexistuje → vytvořit automaticky (7 tabů: entities, names, urls, error, todo, notes, config).
REGISTRACE: zavolat upsert_agent_catalog() po nalezení/vytvoření spreadsheet.
*Limitations: DryRun = nezapisuje; bootstrap vyžaduje DB přístup pro COUNT(*)*

## manager-baseline-file-manager
**For:** Manager only | Baseline soubor agenta, Drive, tab 'entities', bootstrap
Čte a aktualizuje tab 'entities' v master spreadsheet {AgentName} v Agents složce (folder ID: 10AjWPydQjqNKePABVa33GvDZ9JN7xnGd).
Formát řádku: `ImportantScore | TableName | Description | RowCount | LastPopulated`
BOOTSTRAP: pokud spreadsheet neexistuje → vytvořit automaticky (7 tabů).
*Limitations: DryRun = nezapisuje*

## cross-agent-task-writer
**For:** Catalog + Manager | Cross-agent zápis, Names/Urls soubory, task assignment
Zapisuje úkoly pro jiné agenty do jejich master spreadsheet (tab 'names' nebo 'urls', append-only).
Max 50 položek per zápis; tab max 500 řádků. Zaznamenává v highlights[].
*Limitations: NIKDY nepřepisuje celý tab*

## weekly-digest-reporter
**For:** Catalog + Manager | Weekly/monthly digest, souhrnný report, Drive /Prompts/Reports/
Generuje týdenní (každých 7 runů nebo každé pondělí) a měsíční digest.
Catalog: inserted/updated/failed, stale tabulky, backfill progress.
Manager: zpracované zápasy, coverage progress, cross-agent tasks.
*Limitations: min 3-5 runů pro smysluplný digest*

## agent-schedule-manager
**For:** Catalog + Manager | AgentSchedules, denní čas spuštění, přehled agentů
UPSERT (AgentName, ScheduledRunTime, NextRunAt, LastRunAt) na konci každého runu.
Conflict detection: zakázána. Paralelní běh více agentů je povolený.
*Limitations: čas v Europe/Prague; NEZDVOJIT upsert při DryRun*

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

## problem-report-writer
**For:** Catalog + Manager | Problem report, tab 'error' v master spreadsheet, nedokončený run
Zapíše problem report do tabu 'error' v master spreadsheet {AgentName} (VÝHRADNĚ tab 'error', NIKDY samostatný soubor).
Spouští se pokud success=false NEBO selhal ntfy/Calendar/DB report. Spouští se PŘED finálním reportem.
Formát: `ProblemScore | Category | Description | Timestamp | StepStatus`
MCP: VO2QNAPDBAI | VO2QNAPDBTE | VO2QNAPDBMAB | VO2QNAPDBUSM
*Limitations: best-effort — Drive nedostupný → přeskočit tiše*

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

## competition-zone-manager
Spravuje geografické a kompetitivní zóny soutěží (UEFA Champions League groups, FIFA confederations).
Udržuje ZoneType a ZoneName.
*Limitations: pouze pro soutěže s explicitní zone konfigurací*

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

## team-color-scheme-updater
Aktualizuje barevné schéma týmu v Colors sloupci. Home a away barvy ve formátu HEX (#RRGGBB).
*Limitations: pouze HEX formát; neanalyzuje obrázky dresů automaticky*

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

## home-away-record-calculator
Počítá domácí a venkovní záznam pro každý tým per sezóna. W/D/L home/away separátně.
*Limitations: min 3 domácí/venkovní zápasy pro statistiku*

## head-to-head-updater
HeadToHead záznamy po každém zápase. W/D/L, góly, posledních 5 setkání, H/A split.

## assists-leaderboard-updater
Tabulka asistentů per Competition + Season. Z MatchEvents (EventType = assist).

---

# S. ODDS & INTEGRITY (Manager only)

## odds-integrity-monitor
Pohyb odds > 20% → integrity flag + ManualReviewQueue. Implied probability per zápas.

## opening-odds-recorder
Zaznamenává opening odds (kurzy při otevření marketu) z bookmakerů. Ukládá do MatchOdds s odds_type=opening.
*Limitations: opening odds pouze jednou per bookmaker per zápas; nepřepisuje*

## closing-odds-analyzer
Zaznamenává closing odds těsně před začátkem zápasu. Porovnává s opening odds, počítá % pohyb.
*Limitations: closing odds pouze pro zápasy se zaznamenaným opening; bez opening = skip*

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

# W. MANAGER DATA (Manager only)

## data-quarantine-manager
Přesouvá podezřelá sportovní data do QuarantineQueue: duplicitní zápasy, anomální skóre, neidentifikované týmy.
Informuje přes ntfy agent-maintenance.
*Limitations: max 200 záznamů v queue; nepřepisuje produkční data*

---

# X. INFRASTRUKTURA & GOVERNANCE (Catalog only)

## db-table-ownership-checker
**For:** Catalog only | Ownership, permissions, AgentAI, tabulky
Ověřuje, že všechny tabulky v public schema vlastní AgentAI. Detekuje tabulky s jiným ownerem. Navrhuje ALTER TABLE X OWNER TO "AgentAI".
*Limitations: ALTER TABLE nespouští automaticky — vyžaduje superuser potvrzení*

## mcp-version-validator
**For:** Catalog only | MCP version check, startup, minimum version, mcp_version_mismatch
Ověřuje MCP_VERSION >= 10.0.18 při startupu. Pokud nižší → hlásí mcp_version_mismatch, přeskočí mutační operace, pokračuje read-only.
*Limitations: porovnává semver major.minor.patch; pre-release tagy ignoruje*

## schema-mixed-case-detector
**For:** Catalog only | PascalCase vs lowercase, duplicitní sloupce, schema cleanup
Detekuje tabulky kde existují duplicitní sloupce vzniklé smíšením lowercase a PascalCase (např. "name" i "Name"). Navrhuje DDL pro odstranění starší varianty.
*Limitations: DROP nespouští automaticky — data risk; při nejasnosti posílá do ManualReviewQueue*

## mcp-502-recovery-handler
**For:** Catalog only | 502 error, MCP nedostupnost, retry logika, db_502_permanent
Zpracovává 502 Bad Gateway errory. Exponential backoff: 1s → 2s → 4s, max 3 pokusy. Po 3 selháních nastaví db_502_permanent, přeskočí DB operace.
*Limitations: pouze pro 502 HTTP status; jiné chyby neřeší tímto flow*

## drive-oauth-sheets-manager
**For:** Catalog only | Google Sheets, Drive MCP OAuth, spreadsheet bez service accountu
Spravuje operace se spreadsheety přes Google Drive MCP connector (OAuth). Definuje dostupné a nedostupné operace. Při potřebě chybějící funkce hlásí capability_missing s alternativou.
*Limitations: bez service accountu nelze přidávat záložky ani zapisovat data do buněk*

## drive-file-version-selector
**For:** Catalog only | Drive soubory, více verzí, newest selection, governance
Při načítání governance souborů z Drive vybere soubor s nejvyšším VersionNumber z obsahu.
Zabrání použití zastaralé verze. Pokud existuje více verzí → reportuje drive_file_multiple_versions.
*Limitations: musí číst obsah každého souboru pro verzi — pomalé při >10 souborech*

## spreadsheet-tab-initializer
**For:** Catalog only | Master spreadsheet, záložky, inicializace, spreadsheet_tab_missing
Po vytvoření nového master spreadsheestu ověří přítomnost povinných záložek: entities, names, urls, error, todo, notes, config (7 záložek).
*Limitations: Drive MCP neumožňuje vytvoření záložek bez Sheets API — vyžaduje manuální zásah*

## governance-prompt-cache-sync
**For:** Catalog only | AgentPromptCache, verze synchronizace, cache invalidace, cache_refreshed
Po načtení nové verze governance promptu aktualizuje záznam v AgentPromptCache. Pokud cached PromptVersion neodpovídá → přepíše cache a loguje cache_refreshed.
*Limitations: cache write může selhat pokud DB nedostupná — přeskoč a pokračuj*

## agent-startup-health-broadcaster
**For:** Catalog only | Ntfy, startup summary, readiness report, agent-status
Po dokončení startup sekvence pošle na ntfy kanál agent-status: agent name, prompt verze, MCP verze, DB status, počet tabulek, prompt source, run ID.
*Limitations: pokud ntfy nedostupné → přeskoč, loguj ntfy_unavailable, nepřerušuj startup*

## skill-changelog-recorder
**For:** Catalog only | Audit skills, changelog, verzování, skill_added/skill_modified/skill_removed
Loguje přidání, úpravu nebo odebrání skills: datum, skill_name, change_type, reason, operator. Záznamy do SKILL_CHANGELOG a do AgentRunReport.
*Limitations: pouze loguje — nespouští žádné akce automaticky*

---

# Y. AGENT SYNCHRONIZATION (Catalog only)

## agent-entity-sync-manager
**For:** Catalog only | sync_agent_entities, get_agent_entities, cross-agent entity sharing
Orchestruje synchronizaci entit mezi agenty přes MCP nástroje. Conflict resolution: vyšší ConfidenceScore wins.
*Limitations: max 100 entit na sync operaci; nefunguje pokud MCP_VERSION < 10.0.18*

## column-deprecation-manager
**For:** Catalog only | Odebrání sloupce, deprecate_column, schema cleanup
Bezpečně deprecuje DB sloupce: přejmenování na _deprecated_ prefix (ihned), DROP po 30 dnech s potvrzením.
*Limitations: DROP (fáze 2) vyžaduje explicitní operátorský pokyn — nikdy automaticky*

---

## NOVÉ V 10.1.0

Oproti verzi 8.4.0 bylo přidáno nebo výrazně aktualizováno následující:

**Nové Catalog skills:**
- `source-attribution-tracker` — nová sekce H, data lineage reporting
- `baseline-diff-reporter` — porovnání verzí baseline katalogu
- `partial-run-recovery` — obnova přerušeného runu z checkpointu
- `catch-up-scheduler` — plánování catch-up runů po výpadku
- `image-metadata-extractor` — EXIF/IPTC/XMP extrakce z obrázků
- `historical-asset-collector` — sběr historických vizuálních assetů (sdílený s Manager)
- `wikidata-image-harvester` — Wikidata P154/P18/P1419 (sdílený s Manager)
- `image-quality-validator` — validace kvality obrázků (sdílený s Manager)
- `db-table-ownership-checker` — ověření ownership tabulek (nová sekce X)
- `mcp-version-validator` — ověření MCP verze při startupu
- `schema-mixed-case-detector` — detekce smíšeného case v schématu
- `mcp-502-recovery-handler` — zpracování 502 chyb MCP serveru
- `drive-oauth-sheets-manager` — správa Drive/Sheets přes OAuth
- `drive-file-version-selector` — výběr nejnovější verze governance souboru
- `spreadsheet-tab-initializer` — inicializace záložek master spreadsheestu
- `governance-prompt-cache-sync` — synchronizace AgentPromptCache
- `agent-startup-health-broadcaster` — ntfy startup summary na agent-status
- `skill-changelog-recorder` — audit log pro changes skills
- `agent-entity-sync-manager` — cross-agent synchronizace entit (nová sekce Y)
- `column-deprecation-manager` — bezpečná deprecace DB sloupců

**Nové Manager skills:**
- `opening-odds-recorder` — záznam opening odds (nová sekce S)
- `closing-odds-analyzer` — analýza closing odds a line movement
- `competition-zone-manager` — správa zón soutěží (UEFA, FIFA groups)
- `home-away-record-calculator` — domácí/venkovní statistiky týmů
- `team-color-scheme-updater` — aktualizace barevných schémat dresů
- `data-quarantine-manager` — karanténa podezřelých sportovních dat (nová sekce W)
- `kit-timeline-builder` — historické dresy per sezóna
- `season-logo-collector` — season-specific loga soutěží
- `historical-asset-collector` — historické vizuální assety (sdílený s Catalog)
- `wikidata-image-harvester` — Wikidata image harvest (sdílený s Catalog)
- `image-quality-validator` — validace kvality obrázků (sdílený s Catalog)

**Aktualizované skills (změna popisu/limitations):**
- `baseline-catalog-file-manager` — přepracován na master spreadsheet s tab 'entities' a BOOTSTRAP
- `manager-baseline-file-manager` — přepracován na master spreadsheet s tab 'entities' a BOOTSTRAP
- `names-file-processor` — přepracován na tab 'names' v master spreadsheet
- `urls-priority-queue-manager` — přepracován na tab 'urls' v master spreadsheet
- `problem-report-writer` — přepracován na tab 'error' v master spreadsheet (10.0.3 update)
- `agent-schedule-manager` — conflict detection zakázána (9.3.0 update)
- `next-run-calendar-scheduler` — hardcoded CALENDAR_ID, nikdy nepoužívat display name
- `ntfy-notification-sender` — rozšířen o agent-alerts kanál, přesný formát zpráv
- `error-escalation-manager` — Tier3 → agent-alerts, Tier4 → agent-errors
- `cross-agent-task-writer` — přepracován na master spreadsheet append

---

*Konec Skill Directory — CatalogAgent: 127 skills | ManagerAgent: 126 skills*
