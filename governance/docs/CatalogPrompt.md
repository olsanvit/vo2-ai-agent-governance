# CatalogPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Catalog  
**Soubor:** `governance/CatalogPrompt.txt` (5 617 řádků)

---

## Co dělá

Catalog agent spravuje katalog entit čtyř domén: People, Organizations, Sport, Media. Vyhledává nové entity z discovery fronty (max 50 per run), obohacuje jejich metadata (names, URLs), provádí web search fallback, sbírá doplňující informace a ukládá do DB. Implementuje speciální GOVERNED FILE DUPLICATE-GUARD protokol proti duplicitním záznamům. Na rozdíl od Manager agenta nemá „processing" záložku v master spreadsheet — používá 7 záložek.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Catalogs/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `TargetDB` | — | primární DB (MCP konektor) |
| `EntityTypes` | — | People / Organizations / Sport / Media |
| `DiscoveryMaxPerRun` | 50 | max nových entit k discovery za run |
| `DryRun` | false | bez zápisů do DB |
| `ScheduledRunTime` | — | čas plánovaného spuštění |

---

## Průběh (Happy Path)

**Startup sekvence (11 kroků):**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení CatalogPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. MASTER SPREADSHEET — načtení 7 záložek (entities, names, urls, error, todo, notes, config)
6. GOVERNED FILE DUPLICATE-GUARD — kontrola duplicit v řízených souborech
7. AGENT SCHEDULES — přehled plánů z AgentSchedules
8. READINESS — klasifikace stavu
9. AGENT HEALTH REPORT — ntfy topic `agent-health`
10. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
11. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence:**

1. DISCOVERY — načtení max DiscoveryMaxPerRun nových entit z discovery fronty nebo Sheets todo záložky
2. NAMES QUEUE — zpracování fronty pro obohacení jmen entit
3. URLS QUEUE — zpracování fronty pro obohacení URL entit
4. WEB SEARCH FALLBACK — pokud names/urls nenalezeny v DB → web search
5. COLLECT — sběr doplňujících metadat (sociální sítě, profily, statistiky)
6. SAVE — upsert do DB s plným audit trail
7. MASTER SPREADSHEET UPDATE — aktualizace entities/names/urls záložek
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
- Výchozí hodnoty: DiscoveryMaxPerRun=50
- Varování v run reportu, pokračuje

### Master spreadsheet nedostupný
- readiness_status = `degraded`
- Run pokračuje s daty z DB (bez Sheets aktualizace)
- Na konci runu: `sheets_status = degraded` v run reportu

### GOVERNED FILE DUPLICATE-GUARD selhal
- Duplicita v řízených souborech detekována
- Zastavit run, eskalovat na `agent-alerts`
- Zpráva: "Duplicate-guard: duplicitní záznam v řízených souborech — {detail}"
- Čeká na manuální intervenci operátora

### Discovery fronta prázdná
- Žádné nové entity k discovery
- Pokračovat s names/urls/collect frontami (existující entity k obohacení)
- Run ukončen s success=true, discoveries=0

### DiscoveryMaxPerRun dosažen (50 entit)
- Zastavit discovery, pokračovat se zpracováním vybraných 50 entit
- Zbývající entity zůstávají ve frontě pro příští run

### Web search fallback
- Aktivuje se pokud names/urls entity nenalezeny v DB ani Sheets
- Podmínka: entita nemá URL nebo NormalizedName
- Web search vrátí výsledky → pokračovat s collect
- Web search nevrátí výsledky → entita označena jako `unresolvable`, přeskočena

### Entity — nedostatek informací (degraded collect)
- Méně než 2 ověřené zdroje → ConfidenceScore < 0.60
- Status: `draft` — upsertována ale označena jako nekompletní
- Doporučení: manuální doplnění nebo web search retry

### Duplicitní entita detekována
- Stejný NormalizedName + EntityType již v DB → přeskočit INSERT, logovat jako `duplicate_detected`
- Zvýšit ConfidenceScore existujícího záznamu pokud nový zdroj potvrzuje data

### AgentName formát
- Každý Catalog agent musí mít název: `"Catalog of [Entity1], [Entity2], [Entity3], [Entity4] and [Entity5]"`
- Maximálně 5 entity typů v názvu
- AgentName použit jako identifikátor v AgentRunReports

### Master spreadsheet — 7 záložek

| Záložka | Obsah |
|---|---|
| `entities` | hlavní seznam entit s metadaty |
| `names` | fronta pro obohacení jmen |
| `urls` | fronta pro obohacení URL |
| `error` | záznamy chyb z runů |
| `todo` | manuální úkoly operátora |
| `notes` | poznámky operátora |
| `config` | runtime konfigurace přes Sheets |

### Sheets error záložka
- Chyby z run zapisovány do error záložky (i při úspěšném runu)
- Formát: timestamp, AgentName, severity, detail

### DryRun mode
- `DryRun=true` → žádné DB upserty, žádná Sheets aktualizace
- Discovery a collect proběhnou normálně
- Chat výstup označen: "[DRY-RUN]"

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT upsertován jako success=false
- Chyba zapsána do Sheets error záložky

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Run OK | `agent-runs` | default |
| Degraded (Sheets nedostupné) | `agent-alerts` | high |
| Duplicate-guard selhání | `agent-alerts` | high |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `EntityTypes` | People / Organizations / Sport / Media — 4 domény katalogu |
| `DiscoveryMaxPerRun` | max 50 nových entit k discovery za run |
| `GOVERNED FILE DUPLICATE-GUARD` | protokol zabraňující duplicitám v řízených souborech |
| `AgentName formát` | "Catalog of [E1], [E2], [E3], [E4] and [E5]" |
| `7 záložek` | entities / names / urls / error / todo / notes / config |
| `web search fallback` | web search pokud names/urls nenalezeny v DB |
| `NormalizedName` | normalizované jméno entity (key pro deduplication) |
| `draft` | status entity s nedostatkem zdrojů (< 0.60 confidence) |
| `unresolvable` | entita bez nalezených informací po web search |
| `collect` | sběr doplňujících metadat (profily, sociální sítě, statistiky) |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory, master spreadsheet (7 záložek)
- **Web:** web search fallback pro neznámé entity
- **Tabulky DB (zápis):** entity tabulky (People/Organizations/Sport/Media), `AgentRunReports`, `AgentSchedules`
- **MCP nástroje:** `run_select_sql`, `find_records`, `upsert_record`, `get_table_schema`, `list_tables`, `send_notification`, `read_file_content`, `sheets_get_values`, `sheets_update_row`, `sheets_append_rows`
