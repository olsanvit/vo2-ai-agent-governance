# OptimizerPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Optimizer  
**Soubor:** `governance/OptimizerPrompt.txt` (285 řádků)

---

## Co dělá

Optimizer agent implementuje bezpečné optimalizace DB/schema/promptů/plánů. Analyzuje výkonnost dotazů (pg_stat_statements), navrhuje a provádí indexy, vakuum, prompt aktualizace a úpravy plánování agentů. Pracuje s přísnou klasifikací rizika — automaticky provádí pouze „safe" operace. Zapisuje do AgentRunReports a AgentSchedules, nikdy do cílových tabulek destruktivně.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Optimizers/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `TargetDB` | — | primární DB k optimalizaci (MCP konektor) |
| `OptimizationScope` | — | `schema` / `indexes` / `prompts` / `schedules` / `all` |
| `AutoSafeMode` | true | automaticky provádět jen „safe" operace |
| `MaxChangesPerRun` | 10 | max počet změn za jeden run |
| `SlowQueryThreshold` | auto | práh pro pomalé dotazy (auto = avg + 2σ z pg_stat_statements) |
| `RunMode` | — | `auto_safe` / `auto_risky` / `propose_only` |

---

## Průběh (Happy Path)

**Startup sekvence:**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení OptimizerPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. AGENT SCHEDULES — přehled plánů z AgentSchedules
6. READINESS — klasifikace stavu
7. AGENT HEALTH REPORT — ntfy topic `agent-health`
8. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence:**

0. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
1. SLOW QUERY ANALYSIS — top 5 dotazů z pg_stat_statements, výpočet SlowQueryThreshold (avg + 2σ)
2. QUERY PLAN CHECK — EXPLAIN ANALYZE na top 5 dotazů (baseline)
3. INDEX ANALYSIS — chybějící indexy, nepoužívané indexy, bloat
4. VACUUM ANALYSIS — dead_tuple_ratio > 10 % → doporučit VACUUM ANALYZE; bloat > 30 % → VACUUM FULL
5. CONNECTION POOL ANALYSIS — idle_in_transaction > 3 → eskalace na `agent-alerts` (MCP pool leak)
6. OPTIMIZATION HISTORY CHECK — přeskočit optimalizace provedené < 30 dní zpátky
7. OPTIMIZATION EXECUTION — provést dle klasifikace rizika
8. IMPACT MEASUREMENT — EXPLAIN ANALYZE po optimalizaci, srovnání s baseline
9. HANDOFF TO MONITOR — notifikace Monitor agenta o DB zdraví po optimalizaci
10. RUN REPORT — upsert do AgentRunReports
11. SCHEDULE UPDATE — upsert do AgentSchedules
12. CALENDAR EVENT — příští plánovaný run
13. NOTIFICATION — ntfy dle výsledku
14. UNLOCK — uvolnění advisory lock

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
- Výchozí hodnoty: AutoSafeMode=true, MaxChangesPerRun=10
- Varování v run reportu, pokračuje

### Klasifikace rizika operací

| Kategorie | Podmínka | Chování |
|---|---|---|
| `safe` | AutoSafeMode=true | Provést automaticky |
| `risky` | RunMode=auto_risky | Provést jen pokud RunMode=auto_risky |
| `requires_maintenance` | — | Pouze navrhnout, neprovádět |
| `blocked` | — | Manuální intervence operátora |

### Zakázané operace (vždy blocked)
- `DROP TABLE`, `DROP INDEX`, `DELETE`, `TRUNCATE`
- `ALTER TYPE` s konverzí dat
- SSH příkazy
- Jakékoli destruktivní schéma operace

### CREATE INDEX CONCURRENTLY
- Vždy používat `CONCURRENTLY` (neblokuje zápisy)
- Bez CONCURRENTLY → automaticky překlasifikovat na `blocked`

### Optimalizace již provedena (< 30 dní)
- Přeskočit, logovat: `optimization_skipped=true, last_done={datum}`

### MaxChangesPerRun dosažen
- Zastavit provádění dalších změn
- Zbývající optimalizace logovat jako `deferred`
- RUN REPORT s `changes_deferred={N}`

### VACUUM ANALYZE
- Podmínka: dead_tuple_ratio > 10 %
- Klasifikace: `safe`
- Prováděno automaticky

### VACUUM FULL
- Podmínka: bloat > 30 %
- Klasifikace: `requires_maintenance` (blokuje tabulku)
- Pouze navrhnout operátorovi

### Connection pool leak
- idle_in_transaction > 3 → eskalace na `agent-alerts`
- Zpráva: "MCP pool leak: {N} idle_in_transaction spojení"
- Agent neukončuje spojení sám (to je destruktivní)

### Query plan regression
- Po optimalizaci EXPLAIN ANALYZE ukazuje horší plán → automaticky rollback indexu (DROP INDEX CONCURRENTLY)
- Zaznamenáno v run reportu jako `regression_detected=true`

### Handoff to Monitor selhal
- ntfy Monitor agentu o DB zdraví selhal
- Logováno jako `monitor_handoff_failed=true`
- Run jinak pokračuje normálně

### DryRun mode
- `DryRun=true` → žádné zápisy do DB ani schéma změny
- Pouze navrhnout optimalizace v chatu a run reportu
- Chat výstup označen: "[DRY-RUN]"

### AutoSafeMode=false + RunMode=auto_risky
- „Risky" operace prováděny automaticky
- Vždy logovat každou risky operaci do run reportu s odůvodněním

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT upsertován jako success=false

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Optimalizace OK | `agent-runs` | default |
| Connection pool leak | `agent-alerts` | high |
| Query plan regression | `agent-alerts` | high |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `OptimizationScope` | co se optimalizuje: schema / indexes / prompts / schedules / all |
| `AutoSafeMode` | true = automaticky jen safe operace |
| `SlowQueryThreshold` | práh pro pomalé dotazy (auto = avg + 2σ z pg_stat_statements) |
| `safe` | operace bez rizika, provést automaticky |
| `risky` | operace s rizikem, vyžaduje RunMode=auto_risky |
| `requires_maintenance` | jen navrhnout, neprovádět (blokuje tabulku) |
| `blocked` | pouze manuální intervence operátora |
| `CREATE INDEX CONCURRENTLY` | neblokující vytvoření indexu (vždy používat) |
| `optimization history` | přeskočit optimalizace z posledních 30 dní |
| `impact measurement` | EXPLAIN ANALYZE před/po optimalizaci |
| `dead_tuple_ratio` | > 10 % → VACUUM ANALYZE |
| `bloat` | > 30 % → navrhnou VACUUM FULL |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory
- **Tabulky DB (jen čtení):** `pg_stat_statements`, analyzované tabulky
- **Tabulky DB (zápis):** `AgentRunReports`, `AgentSchedules`
- **MCP nástroje:** `run_select_sql`, `get_table_schema`, `list_tables`, `list_indexes`, `create_index`, `send_notification`, `read_file_content`
