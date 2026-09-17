# CheckerPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Checker  
**Soubor:** `governance/CheckerPrompt.txt` (640 řádků)

---

## Co dělá

Checker agent audituje stav DB: ověřuje BaseGuid compliance (Guid, CreatedAt, UpdatedAt, IsDeleted), čerstvost dat, dostupnost zdrojů (URL, SSL), konzistenci schématu a předává problémy Importer agentovi ke zpracování. Provádí pouze aditivní (bezpečné) schema patche. Na konci každého runu potvrzuje, že nepoužil DELETE, DROP ani TRUNCATE.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Checkers/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `TargetDB` | — | primární DB k auditu (MCP konektor) |
| `ExpectedUpdateInterval` | daily | očekávaný interval aktualizace |
| `TableFilter` | — | seznam tabulek nebo `"all"` |
| `CheckpointEnabled` | true | ukládání checkpointů pro partial recovery |
| `DefaultTimeout` | 10s | timeout pro jednotlivé kontroly |
| `ExpectedKeyword` | — | klíčové slovo pro content validation |
| `DryRun` | false | bez zápisů do DB |

---

## Průběh (Happy Path)

**Startup sekvence:**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení CheckerPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. AGENT SCHEDULES — přehled plánů z AgentSchedules
6. READINESS — klasifikace stavu
7. AGENT HEALTH REPORT — ntfy topic `agent-health`
8. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence:**

0. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
1. CHECKPOINT LOAD — načtení předchozího checkpointu pro partial recovery (pokud CheckpointEnabled=true)
2. BASEGUID AUDIT — kontrola Guid, CreatedAt, UpdatedAt, IsDeleted na všech tabulkách v TableFilter
3. FRESHNESS CHECK — kategorizace čerstvosti dat dle stáří záznamu
4. URL AVAILABILITY CHECK — HTTP GET na SourceUrls, timeout DefaultTimeout
5. SSL EXPIRY CHECK — ověření platnosti SSL certifikátů zdrojů
6. CONTENT VALIDATION — klíčové slovo (ExpectedKeyword) v obsahu zdrojů
7. SCHEMA PATCH — aditivní opravy schématu (pouze ADD COLUMN)
8. DEAD SOURCE ARCHIVAL — každých 30 runů archivovat mrtvé zdroje
9. CHECKER→IMPORTER HANDOFF — předání problémů do DiscoveryQueue pro Importer
10. RUN REPORT — upsert do AgentRunReports
11. SCHEDULE UPDATE — upsert do AgentSchedules
12. CALENDAR EVENT — příští plánovaný run
13. NOTIFICATION — ntfy dle výsledku
14. SECURITY CONFIRMATION — povinný závěr: "Potvrzeno: nebyly použity DELETE, DROP ani TRUNCATE"
15. UNLOCK — uvolnění advisory lock

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
- Výchozí hodnoty: ExpectedUpdateInterval=daily, CheckpointEnabled=true, DefaultTimeout=10s
- Varování v run reportu, pokračuje

### Checkpoint — partial recovery
- CheckpointEnabled=true: po přerušení runu načíst checkpoint, pokračovat od přerušeného místa
- Checkpoint uložen po každé úspěšně auditované tabulce

### Kategorie čerstvosti (freshness)

| Kategorie | Stáří záznamu | Závažnost |
|---|---|---|
| OK | < 24 hodin | — |
| Mírné | 24 hodin – 3 dny | low |
| Pozor | 3 – 7 dní | medium |
| Varování | 8 – 30 dní | high |
| Problém | > 30 dní | critical |

### URL nedostupná (timeout nebo chyba)
- Logováno jako `url_check_failed`
- Po 5 po sobě jdoucích selhání (flapping detection) → `flapping=true` → backoff
- Kandidát pro CHECKER→IMPORTER HANDOFF

### SSL certifikát expiruje < 14 dní
- Insight severity=`medium`, eskalace na `agent-alerts`
- SSL certifikát expiruje < 3 dny → severity=`critical`, eskalace na `agent-errors`

### SSL certifikát expirovaný
- Severity=`critical`
- ntfy topic `agent-errors`, priority `urgent`
- Zdroj označen jako nedostupný

### Content validation selhal (chybí ExpectedKeyword)
- Logováno jako `content_validation_failed`
- Severity=`medium` pokud intermitentní
- Severity=`critical` pokud 3× za sebou

### BaseGuid compliance — chybějící sloupec
- Aditivní schema patch: `ALTER TABLE ADD COLUMN IF NOT EXISTS`
- Logováno jako `schema_patch_applied`
- Patch proveden bez výpadku

### BaseGuid compliance — chybějící hodnoty
- Záznamy bez Guid/CreatedAt/UpdatedAt → logováno jako `baseguid_violations={N}`
- Eskalace na `agent-alerts` pokud violations > 0

### Schema patch — destruktivní operace požadována
- Jakákoli neaditivní změna (DROP COLUMN, ALTER TYPE) → odmítnout
- Logováno jako `schema_patch_blocked`
- Eskalace na `agent-alerts` s popisem potřebné změny
- Čeká na manuální intervenci operátora

### Dead source archival
- Každých 30 runů: zdroje s > 30 dny offline → archivovat (IsDeleted=true)
- Logováno: `dead_sources_archived={N}`

### Flapping detection
- Zdroj střídá OK/FAIL → `flapping=true` → zvýšit interval kontroly (backoff)
- Logováno do SourceReliability

### CHECKER→IMPORTER HANDOFF
- Zdroj s problémy vložen do DiscoveryQueue s QueueType="checker_handoff"
- Importer agent zpracuje zdroj při dalším runu

### Result caching
- Výsledky kontroly cachovány; při dalším runu ze stejného dne → použít cache
- Cache invalidována při změně URL nebo schématu

### DryRun mode
- `DryRun=true` → žádné zápisy do DB (ani schema patche)
- Audit výsledky zobrazeny v chatu
- Security confirmation stále vypsána

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT upsertován jako success=false
- Security confirmation stále vypsána (i při selhání)

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Audit OK, bez problémů | `agent-runs` | default |
| BaseGuid violations | `agent-alerts` | high |
| SSL expiruje < 14 dní | `agent-alerts` | high |
| SSL expirovaný / critical freshness | `agent-errors` | urgent |
| Flapping detection | `agent-alerts` | high |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `BaseGuid` | standardní sloupce: Guid uuid PK, CreatedAt, UpdatedAt, IsDeleted |
| `freshness` | kategorizace stáří dat: OK / Mírné / Pozor / Varování / Problém |
| `CheckpointEnabled` | ukládání pozice pro partial recovery po přerušení |
| `DefaultTimeout` | timeout pro URL a DB kontroly (výchozí 10s) |
| `ExpectedKeyword` | klíčové slovo pro content validation zdrojů |
| `flapping detection` | střídání OK/FAIL → backoff |
| `dead source archival` | mrtvé zdroje archivovány každých 30 runů (IsDeleted=true) |
| `schema patch` | pouze aditivní: `ALTER TABLE ADD COLUMN IF NOT EXISTS` |
| `checker→importer handoff` | předání problémových zdrojů do DiscoveryQueue |
| `security confirmation` | závěrečné potvrzení: "nebyly použity DELETE, DROP ani TRUNCATE" |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory
- **Tabulky DB (jen čtení):** všechny tabulky v TableFilter
- **Tabulky DB (zápis):** `AgentRunReports`, `AgentSchedules`, `DiscoveryQueue`, `SourceReliability`
- **MCP nástroje:** `run_select_sql`, `find_records`, `get_table_schema`, `list_tables`, `send_notification`, `read_file_content`
