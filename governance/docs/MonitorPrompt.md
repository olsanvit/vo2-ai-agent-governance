# MonitorPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Monitor  
**Soubor:** `governance/MonitorPrompt.txt` (296 řádků)

---

## Co dělá

Monitor agent sleduje zdraví ostatních agentů, projektů a infrastruktury. Čte záznamy z AgentRunReports, Google Sheets (master spreadsheets agentů) a CI/CD (GitHub Actions). Koreluje chyby z více zdrojů, detekuje ticho agentů (silence detection), generuje upozornění přes ntfy a navrhuje nebo provádí automatické opravy v omezené bezpečné oblasti.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Monitors/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `MonitorScope` | — | `agents` / `projects` / `infrastructure` / `all` |
| `NtfyTopics` | — | seznam témat k monitorování |
| `SheetsFolder` | — | ID Drive složky s master spreadsheets |
| `MaxAlertsPerRun` | 5 | maximální počet ntfy notifikací za jeden run |

---

## Průběh (Happy Path)

**Startup sekvence (9 kroků):**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení MonitorPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. AGENT SCHEDULES — přehled plánů z AgentSchedules
6. READINESS — klasifikace stavu (ok / warn / error)
7. AGENT HEALTH REPORT — ntfy topic `agent-health` s výsledkem startu
8. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence:**

1. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
2. DATA COLLECTION — načtení AgentRunReports za posledních N hodin, Sheets chybových záložek, CI výsledků z GitHub
3. AGENT SILENCE DETECTION — pokud agent nevidět déle než 2× jeho `IntervalHours` → eskalace
4. CORRELATION ENGINE — ntfy chyba + Sheets chyba + CI selhání pro stejný `AgentName` do 2 hodin → jeden root cause
5. PREDICTIVE ALERTING — pokud chybovost roste 3+ po sobě jdoucí runy → eskalovat před dosažením kritického prahu
6. WEEKLY HEALTH SCORE — výpočet: `(success_runs/total)*70 + (no_SLA_breach)*20 + (no_missed_runs)*10`
7. AUTO-FIX (pokud detekována opravitelná příčina v bezpečné oblasti)
8. RUN REPORT — upsert do AgentRunReports
9. SCHEDULE UPDATE — upsert do AgentSchedules + dynamic frequency adjustment
10. CALENDAR EVENT — vytvoření záznamu pro příští plánovaný run
11. NOTIFICATION — ntfy dle výsledku
12. UNLOCK — uvolnění advisory lock

---

## Větvení a výjimky

### DB nedostupná (db_unreachable)
- readiness_status = `error`
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT zapsán přes fallback (Drive nebo lokálně)
- Run se NEPOKRAČUJE do analýzy

### Prompt cache selhal
- Pořadí záložek: MCP → vo2info.cz → GitHub raw → Drive → DB cache → bootstrap
- Každý fallback logován jako `prompt_status = outdated | drive_unavailable`
- Pokud všechny selžou: bootstrap prompt, pokračovat s varováním

### ntfy nedostupná
- `capability_missing("ntfy")` logováno
- Run pokračuje, výsledky jdou pouze do DB run reportu a Drive

### Advisory lock obsazen
- Jiná instance agenta běží → okamžitě ukončit
- `lock_status = skipped` v run reportu

### Config soubor chybí
- Agent použije výchozí hodnoty (MonitorScope=all, MaxAlertsPerRun=5)
- Varování v run reportu, pokračuje

### Agent silence detected
- Agent neviděn déle než 2× `IntervalHours`
- ntfy topic `agent-alerts`, priority `high`
- Zaznamenáno v run reportu jako `silence_detected=true`

### Alert fatigue prevention
- Stejný problém (AgentName + ErrorType) detekovaný do 4 hodin od předchozího alertu → přeskočit ntfy, jen logovat do DB
- Zabrání zahlcení notifikacemi při opakující se chybě

### Korelace chyb (correlation engine)
- ntfy error + Sheets error + CI selhání pro stejný `AgentName` do 2 hodin → agregovat do jednoho root cause alertu
- Pokud korelace nalezena: jeden ntfy místo tří

### Prediktivní alert
- Chybovost roste 3+ po sobě jdoucích runů → eskalovat na `agent-alerts` ještě před dosažením kritického prahu
- Zpráva: "Rostoucí chybovost: {AgentName} — {N} runů po sobě"

### QNAP infrastruktura (MonitorScope=infrastructure)
- CPU load > 10 → `WARNING` na `agent-alerts`
- CPU load > 50 → `CRITICAL` na `agent-errors`
- Disk > 85 % → `WARNING` na `agent-alerts`
- Detekce pomocí DB dotazů nebo MCP nástrojů

### Auto-fix — bezpečná oblast
- Povoleno: GitHub PR merge, submodule update, workflow YAML oprava
- Nikdy: SSH příkazy, DB destruktivní operace, restart kontejnerů
- Po auto-fix: čekat 5 minut, znovu ověřit zdraví

### Recovery confirmation selhal
- Auto-fix proveden, ale re-ověření po 5 minutách stále ukazuje problém
- Eskalace na `agent-errors` s příznakem `fix_failed=true`

### DryRun mode
- `DryRun=true` → žádné zápisy do DB (AgentRunReports, AgentSchedules)
- Notifikace stále odesílány (ntfy je informativní, ne zápis)
- Chat výstup označen: "[DRY-RUN]"

### Kritické nálezy v analýze
- ntfy topic `agent-errors`, priority `urgent`
- Zpráva obsahuje: počet kritických nálezů, top problém, navrhované řešení

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- Zpráva obsahuje: primární chybu, stav DB, doporučenou akci

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Analýza OK, bez kritických nálezů | `agent-runs` | default |
| Silence detection | `agent-alerts` | high |
| Prediktivní alert | `agent-alerts` | high |
| QNAP WARNING | `agent-alerts` | high |
| Kritické nálezy / QNAP CRITICAL | `agent-errors` | urgent |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram (infrastruktura na QNAPu, bez akce agenta).

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `MonitorScope` | co agent monitoruje: agents / projects / infrastructure / all |
| `silence detection` | agent neviděn déle než 2× svůj `IntervalHours` |
| `correlation engine` | agregace chyb ze 3 zdrojů (ntfy + Sheets + CI) do jednoho root cause |
| `alert fatigue prevention` | stejný problém do 4 hodin → přeskočit ntfy |
| `predictive alerting` | rostoucí chybovost 3+ runy → eskalovat předem |
| `weekly health score` | (success_runs/total)*70 + (no_SLA_breach)*20 + (no_missed_runs)*10 |
| `auto-fix` | bezpečná automatická oprava: GitHub PR, submodule, workflow YAML |
| `MaxAlertsPerRun` | max počet ntfy notifikací za jeden run (výchozí 5) |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory, master spreadsheets agentů
- **GitHub:** CI/CD výsledky (GitHub Actions API)
- **ntfy:** ntfy.vo2info.cz — doručení notifikací
- **Tabulky DB:** `AgentRunReports`, `AgentSchedules`
- **MCP nástroje:** `run_select_sql`, `find_records`, `send_notification`, `read_file_content`
