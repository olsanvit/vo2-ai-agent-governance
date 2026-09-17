# CollectorPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Collector  
**Soubor:** `governance/CollectorPrompt.txt` (681 řádků)

---

## Co dělá

Collector agent sbírá položky z webu a dalších zdrojů, klasifikuje je do kategorií a ukládá do DB. Používá category listy pro rovnoměrné rozložení sběru, detekuje duplikáty přes content hash, respektuje robots.txt, dodržuje rate limiting a implementuje circuit breaker vzor pro nefunkční zdroje. Po sběru předává nová data do DiscoveryQueue pro Generator agenta.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Collectors/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `CollectionTypes` | — | seznam typů sběru (např. articles, players, clubs) |
| `CollectionMode` | incremental | `incremental` / `full` |
| `LookbackWindow` | 7d | okno pro incremental sběr |
| `FullCollectionDay` | 1 | den v měsíci pro full collection |
| `MaxPagesPerSource` | 5 | maximální počet stránek z jednoho zdroje |

---

## Průběh (Happy Path)

**Startup sekvence:**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení CollectorPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. CATEGORY LISTS LOAD — načtení `{AgentName}_categories_{type}.txt` pro každý CollectionType
6. AGENT SCHEDULES — přehled plánů z AgentSchedules
7. READINESS — klasifikace stavu
8. AGENT HEALTH REPORT — ntfy topic `agent-health`
9. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence:**

0. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
1. CIRCUIT BREAKER CHECK — přeskočit zdroje s OPEN circuit breaker
2. ROBOTS.TXT CHECK — ověření robots.txt před prvním scrapingem domény (výsledek cachován)
3. BALANCE ANALYSIS — `priority_score = max_count - category_count` → sbírat od nejvíce podreprezentovaných kategorií
4. COLLECTION LOOP — pro každý zdroj a CollectionType:
   - rate limit (2s mezi requesty na stejnou doménu)
   - content hash deduplication (MD5 prvních 5000 znaků)
   - pagination (až MaxPagesPerSource stránek)
5. CLASSIFICATION — zařazení do kategorií dle category lists
6. DB UPSERT — uložení s data provenance (SourceUrl, CollectedAt, CollectedBy, ContentHash)
7. GENERATOR HANDOFF — nová data → DiscoveryQueue s QueueType="collector_handoff"
8. RUN REPORT — upsert do AgentRunReports
9. SCHEDULE UPDATE — upsert do AgentSchedules
10. CALENDAR EVENT — příští plánovaný run
11. NOTIFICATION — ntfy dle výsledku
12. UNLOCK — uvolnění advisory lock

---

## Větvení a výjimky

### DB nedostupná (db_unreachable)
- readiness_status = `error`
- ntfy topic `agent-errors`, priority `urgent`
- Run se nepokračuje
- RUN REPORT zapsán (success=false)

### Prompt cache selhal (všechny fallbacky)
- Bootstrap prompt, logováno jako `prompt_status = drive_unavailable`
- Pokračovat s varováním

### ntfy nedostupná
- `capability_missing("ntfy")` logováno
- Run pokračuje

### Advisory lock obsazen
- Jiná instance agenta běží → okamžitě ukončit
- `lock_status = skipped` v run reportu

### Config soubor chybí
- Výchozí hodnoty: CollectionMode=incremental, LookbackWindow=7d, MaxPagesPerSource=5
- Varování v run reportu, pokračuje

### Category list soubor chybí
- `{AgentName}_categories_{type}.txt` nenalezen
- Logováno jako `category_list_missing={type}`
- Sběr pro daný typ probíhá bez kategorizace, jen logování

### Robots.txt blokuje scraping
- robots.txt obsahuje Disallow pro agenta nebo všechny crawlery
- Zdroj označen jako `robots_blocked=true`
- Přeskočit, eskalovat na `agent-alerts`
- Zpráva: "Robots.txt blokuje: {url}"

### JS-rendered stránka
- Response body < 500 znaků AND obsahuje `<script>`
- Označit jako `requires_browser=true`
- Přeskočit, eskalovat na `agent-alerts`
- Zpráva: "JS-rendered page, nelze scrapovat: {url}"

### Duplikát detekován (content hash)
- MD5 prvních 5000 znaků se shoduje s existujícím záznamem
- Přeskočit upsert
- Logováno jako `duplicates_skipped={N}`

### Domain rate limit
- 2s pauza mezi requesty na stejnou doménu (výchozí)
- Tier 1 zdroje: 1s pauza
- Tier 3/4 zdroje: 5s pauza
- Překročení → čekat, nepřeskakovat

### Pagination — konec stránek
- Stránky čteny až do MaxPagesPerSource nebo dokud není `nextPage`
- nextPage URL uložena do SourceReliability.Notes pro příští run

### Pagination přesáhla MaxPagesPerSource
- Zastavit stránkování
- Logováno: `pagination_capped=true, last_page={N}`
- nextPage uložena do SourceReliability.Notes

### Circuit breaker — 5 selhání za sebou → OPEN
- Stav: OPEN — zdroj přeskočen po dobu 24 hodin
- Logováno: `circuit_breaker=OPEN, source={url}`
- Eskalace na `agent-alerts`

### Circuit breaker — HALF-OPEN (po 24 hodinách)
- Proveden 1 testovací request
- Úspěch → CLOSED (zdroj obnoven)
- Selhání → znovu OPEN na dalších 24 hodin

### Data provenance — chybějící pole
- SourceUrl, CollectedAt, CollectedBy, ContentHash jsou povinné na každém záznamu
- Bez těchto polí → záznam odmítnout, logovat jako `provenance_error`

### Generator handoff selhal (DiscoveryQueue)
- Vložení do DiscoveryQueue selhalo → logováno jako `generator_handoff_failed`
- Nasbíraná data jsou v DB, handoff se zkusí při dalším runu

### DryRun mode
- `DryRun=true` → žádné zápisy do DB
- Scraping a klasifikace proběhnou normálně
- Chat výstup označen: "[DRY-RUN]", výsledky zobrazeny bez uložení

### Full collection mode
- CollectionMode=full nebo dnes=FullCollectionDay → sbírat všechny dostupné záznamy (ignorovat LookbackWindow)
- Může trvat výrazně déle než incremental run

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT upsertován jako success=false

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Sběr OK | `agent-runs` | default |
| Robots.txt blokuje | `agent-alerts` | high |
| JS-rendered stránka | `agent-alerts` | high |
| Circuit breaker OPEN | `agent-alerts` | high |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `CollectionTypes` | typy položek ke sběru (per CollectionType existuje category list soubor) |
| `CollectionMode` | `incremental` (LookbackWindow) / `full` (všechny dostupné záznamy) |
| `balance analysis` | `priority_score = max_count - category_count` → nejpodreprezentovanější kategorie první |
| `content hash` | MD5 prvních 5000 znaků — deduplication |
| `circuit breaker` | 5 selhání → OPEN 24h → HALF-OPEN (1 test) → CLOSED nebo OPEN |
| `robots.txt compliance` | ověření před prvním scrapingem, výsledek cachován |
| `requires_browser` | JS-rendered stránka — nelze staticky scrapovat |
| `data provenance` | SourceUrl + CollectedAt + CollectedBy + ContentHash povinné |
| `collector→generator handoff` | DiscoveryQueue s QueueType="collector_handoff" |
| `pagination` | až MaxPagesPerSource stránek, nextPage URL do SourceReliability |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory, category list soubory
- **Web:** HTTP scraping zdrojů (robots.txt, pagination)
- **Tabulky DB (zápis):** sbírané tabulky, `AgentRunReports`, `AgentSchedules`, `DiscoveryQueue`, `SourceReliability`
- **MCP nástroje:** `run_select_sql`, `find_records`, `upsert_record`, `send_notification`, `read_file_content`
