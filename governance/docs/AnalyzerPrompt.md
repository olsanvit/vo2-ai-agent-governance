# AnalyzerPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Analyzer  
**Soubor:** `governance/AnalyzerPrompt.txt` (275 řádků)

---

## Co dělá

Analyzer agent provádí hloubkovou read-only analýzu dat v DB. Detekuje trendy, anomálie, problémy s kvalitou dat, schema drift a generuje strukturované reporty s doporučeními. Zapisuje pouze do AgentRunReports a AgentSchedules — nikdy do analyzovaných tabulek. Výstupem je report na Google Drive a run report v DB. Alias „Review" agent (code review / data review) sdílí tento prompt.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Analyzers/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `TargetDB` | — | primární DB k analýze (MCP konektor) |
| `AnalysisScope` | — | tabulky nebo `"all"` |
| `ReportFolder` | — | ID Drive složky pro výstupní reporty |
| `ReportFormat` | — | `markdown` / `json` / `both` |
| `LookbackDays` | 30 | historické okno analýzy (dny) |
| `AnomalyThreshold` | 2.0 | počet σ pro detekci anomálie |
| `MaxAnalysisDuration` | 300 | max čas pro data collection (sekundy) |
| `ScheduledRunTime` | — | čas plánovaného spuštění |

---

## Průběh (Happy Path)

**Startup sekvence (9 kroků):**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení AnalyzerPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. SCHEMA OVERVIEW — `list_tables()` + `get_table_schema()` pro tabulky v AnalysisScope
6. BASELINE LOAD — referenční metriky z předchozího run reportu nebo Drive baseline
7. AGENT SCHEDULES — přehled plánů z AgentSchedules
8. READINESS — klasifikace stavu (ok / warn / error)
9. AGENT HEALTH REPORT — ntfy topic `agent-health` s výsledkem startu

**Run sekvence:**

0a. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)  
0b. ANALYSIS TIMER START — zaznamenat `START = NOW()`; po každém datovém kroku ověřit `elapsed`; pokud `elapsed > MaxAnalysisDuration` → přeskočit zbývající tabulky  
0c. FALSE POSITIVE FILTER — načtení `{AgentName}_false_positives.txt` z Drive; filtrování insightů dle vzorů  
0. LOCK — `pg_try_advisory_lock` per-agent  
1. DATA COLLECTION — `run_select_sql` pro každou tabulku (counts, trendy, NULL hodnoty, duplicity)  
1b. SCHEMA DRIFT DETECTION — porovnání aktuálního schématu s předchozím snapshotem z AgentRunReports  
2. TREND ANALYSIS — srovnání s předchozím runem + baseline; growth / decay / anomálie / stagnace  
2b. COMPARATIVE ANALYSIS — WoW (week-over-week) a MoM (month-over-month) pokud LookbackDays ≥ 30  
2c. CROSS-TABLE CORRELATION — hledání časové korelace anomálií mezi tabulkami (±24h okno)  
3. QUALITY ASSESSMENT — BaseGuid completeness, freshness, FK integrity, enum hodnoty  
4. INSIGHT GENERATION — max 10 nálezů; každý: kategorie, závažnost, důkazy, doporučení, hypotéza příčiny  
4b. INSIGHT DEDUPLICATION — stejný insight 3× za sebou → `persistent_issue` → eskalace na `agent-alerts`  
5. RECOMMENDATIONS — seřazeny dle priority: KRITICKÉ → STŘEDNÍ → NÍZKÉ  
6. REPORT WRITE — uložení do ReportFolder jako `{AgentName}-YYYY-MM.md` (nebo `.json`)  
6b. REPORT DIFF — porovnání s předchozím reportem: nové / vyřešené / přetrvávající nálezy  
7. RUN REPORT — upsert do AgentRunReports (vždy, i při selhání)  
7a. SCHEDULE UPDATE — upsert do AgentSchedules + dynamic frequency adjustment  
8. CALENDAR EVENT — vytvoření záznamu pro příští plánovaný run  
9. NOTIFICATION — ntfy dle výsledku  
10. UNLOCK — uvolnění advisory lock

---

## Větvení a výjimky

### DB nedostupná (db_unreachable)
- readiness_status = `error`
- ntfy topic `agent-errors`, priority `urgent`
- Run se nepokračuje do analýzy
- RUN REPORT zapsán (success=false)

### Prompt cache selhal (všechny fallbacky)
- Použit bootstrap prompt, logováno jako `prompt_status = drive_unavailable`
- Pokračovat s varováním

### ntfy nedostupná
- `capability_missing("ntfy")` logováno
- Run pokračuje, výsledky jdou do DB run reportu a Drive

### Advisory lock obsazen
- Jiná instance agenta běží → okamžitě ukončit
- `lock_status = skipped` v run reportu

### Config soubor chybí
- Výchozí hodnoty: LookbackDays=30, AnomalyThreshold=2.0, MaxAnalysisDuration=300
- Varování v run reportu, pokračuje

### Analysis timeout
- `elapsed > MaxAnalysisDuration` → přeskočit zbývající tabulky
- `analysis_timeout=true`, `tables_skipped={N}`, `tables_analyzed={M}` v run reportu
- Analýza nekompletní, ale RUN REPORT upsertován

### False positive soubor chybí
- `{AgentName}_false_positives.txt` nenalezen → přeskočit filtrování
- Pokračuje bez filtru

### Schema drift — nový sloupec
- Insight kategorie=`schema`, severity=`medium`
- Uložen schema snapshot do AgentRunReports.Notes

### Schema drift — chybějící sloupec
- Insight kategorie=`schema`, severity=`critical`
- Eskalace na `agent-alerts`

### Persistent insight (3× za sebou)
- Insight (kategorie + tabulka + severity) opakuje 3× po sobě → `persistent_issue`
- Eskalace na `agent-alerts` (nestačí jen `agent-runs`)
- Zpráva: "Persistentní problém: {insight} — {N}. occurrence za sebou"

### Velká tabulka (> 100K řádků)
- Použit stratified sampling: `TABLESAMPLE SYSTEM(1) LIMIT 10000`
- Uvést v reportu: "Analýza na {N} vzorcích z {total} řádků (1% sample)"
- Nikdy full scan na tabulkách > 1M řádků bez explicitního pokynu operátora

### Kritické nálezy (critical > 0)
- ntfy topic `agent-errors`, priority `urgent`
- Zpráva: počet kritických nálezů, top nález, doporučení

### Report nelze zapsat na Drive
- Chyba zaznamenána v RUN REPORT (ReportPath=null)
- Run jinak pokračuje jako success (analýza proběhla)

### DryRun mode
- `DryRun=true` → žádné zápisy do DB
- Report se zapíše na Drive (Drive je výstup, ne zápis do DB)
- Chat výstup označen: "[DRY-RUN]"

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT upsertován jako success=false

### Comparative analysis — chybí historická data
- Žádný run report před 7/30 dny → přeskočit WoW/MoM
- Uvést: "WoW: nedostatek dat | MoM: nedostatek dat"

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Analýza OK, critical=0 | `agent-runs` | default |
| Kritické nálezy (critical > 0) | `agent-errors` | urgent |
| Persistent insight | `agent-alerts` | high |
| Schema drift — chybějící sloupec | `agent-alerts` | high |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `AnalysisScope` | tabulky nebo "all" — co se analyzuje |
| `LookbackDays` | historické okno analýzy (výchozí 30 dní) |
| `baseline` | referenční hodnoty z předchozího runu |
| `insight` | konkrétní nález podložený daty (kategorie, závažnost, důkazy, doporučení) |
| `false_positive` | insight označený operátorem jako irelevantní |
| `AnomalyThreshold` | počet σ pro detekci anomálie (výchozí 2.0) |
| `MaxAnalysisDuration` | max čas data collection fáze v sekundách (výchozí 300) |
| `persistent_issue` | stejný insight 3× za sebou → eskalace |
| `QualityScore` | `completeness*40 + freshness*30 + consistency*30` |
| `WoW / MoM` | week-over-week / month-over-month srovnání |
| `TABLESAMPLE SYSTEM(1)` | 1% stratified sample pro tabulky > 100K řádků |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory, false_positives, výstupní reporty
- **Tabulky DB (jen čtení):** všechny tabulky v `AnalysisScope`
- **Tabulky DB (zápis):** `AgentRunReports`, `AgentSchedules`
- **MCP nástroje:** `run_select_sql`, `find_records`, `get_table_schema`, `list_tables`, `read_file_content`, `create_file`, `update_file`, `send_notification`
