# ManagerPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Manager  
**Soubor:** `governance/ManagerPrompt.txt` (4 810 řádků)

---

## Co dělá

Manager agent (SportovnI data Manager) je nejkomplexnější governance agent. Orchestruje celý sportovní datový pipeline — zpracovává výsledky zápasů, events, standings, statistiky hráčů, sestavy, kurzy a H2H data. Provozuje 20-krokový plánovaný run a řídí post-match pipeline ve 4 tierech (Tier 1–4). Má 8 záložek v master spreadsheet (včetně „processing" záložky pro sledování pipeline stavu). Provádí self-update PATCH verzí vlastního promptu autonomně.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Managers/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `TargetDB` | — | primární DB (MCP konektor) |
| `SportScope` | — | sporty a ligy ke zpracování |
| `DryRun` | false | bez zápisů do DB |
| `ScheduledRunTime` | — | čas plánovaného spuštění |
| `OddsIntegrityThreshold` | 20 % | práh pohybu kurzů pro alert |
| `DisciplinaryThreshold` | — | práh disciplinárních opatření |

---

## Průběh (Happy Path)

**Startup sekvence:**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení ManagerPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. MASTER SPREADSHEET — načtení 8 záložek (entities, names, urls, error, todo, notes, config, processing)
6. AGENT SCHEDULES — přehled plánů z AgentSchedules
7. READINESS — klasifikace stavu
8. AGENT HEALTH REPORT — ntfy topic `agent-health`
9. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
10. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence (20 kroků):**

1. SCOPE DETECTION — určení sportů, lig a data range (date <= yesterday Prague TZ)
2. MATCH DISCOVERY — nalezení dokončených zápasů ke zpracování
3. PIPELINE STATUS CHECK — kontrola processing záložky (co bylo zpracováno)
4. TIER 1 PIPELINE — scores, events, standings (ihned po dokončení zápasu)
5. TIER 2 PIPELINE — attendance, stats, lineups, odds (do 24 hodin)
6. TIER 3 PIPELINE — ratings, H2H, form (do 7 dní)
7. TIER 4 PIPELINE — conditions, broadcast, VAR (kdykoli)
8. ODDS INTEGRITY CHECK — detekce pohybu kurzů > OddsIntegrityThreshold
9. DISCIPLINARY CHECK — kontrola disciplinárních opatření přes DisciplinaryThreshold
10. SPORTPROGRESS SLOTS — zpracování historického scanu (7 slotů pro Claude CCR)
11. STANDINGS UPDATE — aktualizace tabulek
12. IMPORT IMPORTANCE CHECK — ověření ImportantScore pro každý datový typ
13. PROCESSING TAB UPDATE — aktualizace processing záložky v master spreadsheet
14. SELF-UPDATE CHECK — kontrola dostupnosti novějšího PATCH promptu
15. RUN REPORT — upsert do AgentRunReports
16. SCHEDULE UPDATE — upsert do AgentSchedules
17. CALENDAR EVENT — příští plánovaný run
18. NOTIFICATION — ntfy dle výsledku
19. UNLOCK — uvolnění advisory lock
20. CHAT REPORT — závěrečný výstup do chatu

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
- Výchozí hodnoty z promptu
- Varování v run reportu, pokračuje

### Master spreadsheet nedostupný
- readiness_status = `degraded`
- Run pokračuje s daty z DB (bez Sheets aktualizace)
- Processing záložka nektualizována → stav pipeline nelze ověřit ze Sheets

### SCOPE — datum dnešní (Prague TZ)
- Agent zpracovává pouze `date <= yesterday Prague TZ`
- Včerejší datum NIKDY neoznačit jako `exhausted` (mohou ještě přibývat data)
- Dnešní datum ignorovat úplně

### Post-match pipeline Tier 1–4

| Tier | Obsah | Časové okno |
|---|---|---|
| Tier 1 | Scores, Events, Standings | Ihned po dokončení zápasu |
| Tier 2 | Attendance, Stats, Lineups, Odds | Do 24 hodin |
| Tier 3 | Ratings, H2H, Form | Do 7 dní |
| Tier 4 | Conditions, Broadcast, VAR | Kdykoli |

### Tier zpracování — neúplná data
- Tier 1 data chybí → přeskočit Tier 2, 3, 4 pro daný zápas
- Logováno: `tier_blocked=true, zápas_id={id}, missing_tier=1`

### Tier 2–4 — časové okno vypršelo
- Data pro Tier 2 starší než 24 hodin → označit jako `tier2_expired`
- Data pro Tier 3 starší než 7 dní → označit jako `tier3_expired`
- Logováno, eskalace na `agent-alerts` pokud opakovaně

### ImportantScore — priority dat

| Tabulka | ImportantScore |
|---|---|
| Matches, Teams, Competitions | 100 |
| Players, Seasons | 95 |
| Standings, MatchEvents | 90 |
| ... ostatní | 80 a méně |

- Zpracovávat tabulky sestupně dle ImportantScore
- Nízké ImportantScore → přeskočit pokud MaxAnalysisDuration blíží

### Odds integrity check
- Pohyb kurzů > OddsIntegrityThreshold (výchozí 20 %) → flag `odds_integrity_alert=true`
- Eskalace na `agent-alerts`
- Zpráva: "Podezřelý pohyb kurzů: {match_id}, pohyb {N}%"

### Disciplinary check
- Počet disciplinárních opatření překračuje DisciplinaryThreshold
- Eskalace na `agent-alerts`
- Zpráva: "Disciplinární threshold překročen: {N} opatření za run"

### Circuit breaker — datový zdroj
- Zdroj selhává 5× za sebou → OPEN 24 hodin
- Tier zpracování pro daný zdroj přeskočeno
- Eskalace na `agent-alerts`

### SportProgress slots (Claude CCR)
- 7 slotů pro historický scan (Claude CCR nemá neomezené volání API)
- Každý slot = jeden historický match nebo sezóna
- Slot naplněn → čekat na příští run

### Self-update — PATCH verze
- Agent autonomně bumpe PATCH verzi vlastního promptu (X.Y.Z → X.Y.Z+1)
- MINOR a MAJOR verze vyžadují operátorský zásah
- Self-update logován v AgentRunReports a drive
- Po self-update: restartovat kontext s novou verzí

### Self-audit
- Podmínka: explicitní žádost | první run | každých 30 runů
- Auditovat: BaseGuid compliance, vlastní AgentRunReports, processing záložka konzistence

### Processing záložka — 8. záložka master spreadsheet

| Sloupec | Obsah |
|---|---|
| MatchId | identifikátor zápasu |
| Tier1Done | timestamp Tier 1 zpracování |
| Tier2Done | timestamp Tier 2 zpracování |
| Tier3Done | timestamp Tier 3 zpracování |
| Tier4Done | timestamp Tier 4 zpracování |
| Status | pending / in_progress / done / error |

### Master spreadsheet — 8 záložek

| Záložka | Obsah |
|---|---|
| `entities` | entity ke správě |
| `names` | fronta jmen |
| `urls` | fronta URL |
| `error` | záznamy chyb |
| `todo` | manuální úkoly |
| `notes` | poznámky |
| `config` | runtime konfigurace |
| `processing` | post-match pipeline stav |

### DryRun mode
- `DryRun=true` → žádné DB zápisy, žádná Sheets aktualizace
- Pipeline analýza proběhne, výsledky v chatu
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
| Odds integrity alert | `agent-alerts` | high |
| Disciplinary threshold | `agent-alerts` | high |
| Circuit breaker OPEN | `agent-alerts` | high |
| Tier zpracování expiroval | `agent-alerts` | high |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `Post-match pipeline` | 4-tier zpracování dat po dokončení zápasu |
| `Tier 1–4` | priority vrstev: scores → attendance → ratings → conditions |
| `ImportantScore` | priorita datového typu: Matches=100, Players=95, Standings=90... |
| `OddsIntegrityThreshold` | 20 % pohyb kurzů → alert |
| `SportProgress slots` | 7 slotů pro historický scan (Claude CCR) |
| `processing záložka` | 8. záložka master spreadsheet — sledování pipeline stavu |
| `self-update` | agent autonomně bumpe PATCH verzi vlastního promptu |
| `Prague TZ` | časová zóna pro výpočet "včerejší datum" |
| `exhausted` | označení dne jako zcela zpracovaného — NIKDY pro včerejší datum |
| `circuit breaker` | 5 selhání datového zdroje → OPEN 24 hodin |
| `DisciplinaryThreshold` | práh disciplinárních opatření pro alert |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory, master spreadsheet (8 záložek)
- **SportRadius / Sports API:** zdroje dat pro zápasy (score, events, stats)
- **Odds API:** zdroj kurzů pro Tier 2
- **Tabulky DB (zápis):** Matches, Teams, Competitions, Players, Seasons, Standings, MatchEvents, `AgentRunReports`, `AgentSchedules`
- **MCP nástroje:** `run_select_sql`, `find_records`, `upsert_record`, `get_table_schema`, `list_tables`, `send_notification`, `read_file_content`, `sheets_get_values`, `sheets_update_row`, `sheets_append_rows`
