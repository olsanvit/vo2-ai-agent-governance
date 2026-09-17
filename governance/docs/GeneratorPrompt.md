# GeneratorPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Generator  
**Soubor:** `governance/GeneratorPrompt.txt` (637 řádků)

---

## Co dělá

Generator agent generuje obrázky pro entity v DB, které nemají vyplněný `ImageColumn`. Zpracovává DiscoveryQueue od Collector agenta, prioritizuje tabulky s nejnižším pokrytím a používá kontextuální batch generaci (skupiny dle sport/liga/sezóna). Implementuje přísná bezpečnostní pravidla: hallucination guard, confidence floor, prompt injection guard a failure budget.

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Generators/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `TargetTables` | — | seznam tabulek s entitami |
| `ImageColumn` | — | název sloupce pro URL obrázku |
| `ScopeFilter` | — | filtr entit (např. sport, liga) |
| `MaxPerRun` | 10 | max entit ke zpracování za run |
| `MaxGenerationsPerRun` | 50 | max volaní create_image za run |
| `ImageSize` | 1024x1024 | rozměr generovaných obrázků |

---

## Průběh (Happy Path)

**Startup sekvence:**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení GeneratorPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. AGENT SCHEDULES — přehled plánů z AgentSchedules
6. READINESS — klasifikace stavu
7. AGENT HEALTH REPORT — ntfy topic `agent-health`
8. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence:**

0. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
1. DISCOVERY QUEUE CHECK — načtení položek z DiscoveryQueue (QueueType="collector_handoff")
2. COVERAGE ANALYSIS — výpočet % pokrytí ImageColumn pro každou tabulku; priorita = nejnižší %
3. ENTITY SELECTION — výběr entit bez ImageColumn (respektuje MaxPerRun)
4. QUALITY GATE — validace každé entity před generací
5. CONTEXTUAL BATCH GROUPING — seskupit entity dle sport/liga/sezóna (max 10 per batch)
6. IMAGE GENERATION — volání create_image s 2s pauzou mezi voláními
7. ENTITY CONFLICT RESOLUTION — vyřešení konfliktů při více zdrojích
8. DB UPSERT — uložení URL vygenerovaného obrázku do ImageColumn
9. RUN REPORT — upsert do AgentRunReports
10. SCHEDULE UPDATE — upsert do AgentSchedules
11. CALENDAR EVENT — příští plánovaný run
12. NOTIFICATION — ntfy dle výsledku
13. UNLOCK — uvolnění advisory lock

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
- Výchozí hodnoty: MaxPerRun=10, MaxGenerationsPerRun=50, ImageSize=1024x1024
- Varování v run reportu, pokračuje

### create_image nedostupný (Claude agenti)
- Claude agenti nemají create_image → `capability_missing("create_image")`
- Entita přeskočena, logována jako `generation_skipped=capability_missing`
- Run pokračuje (generace nelze, ale upsert existujících dat ano)

### Entita již má obrázek (ImageColumn nenní prázdný)
- Přeskočit — nikdy nepřepisovat existující obrázek
- Logováno: `entity_skipped=already_has_image`

### Quality gate — entita nesplňuje podmínky

| Podmínka | Akce |
|---|---|
| NormalizedName prázdný (< 2 znaky) | Přeskočit, `quality_gate_failed=name` |
| ConfidenceScore nedefinován | Přeskočit, `quality_gate_failed=confidence` |
| EntityType neplatný | Přeskočit, `quality_gate_failed=entity_type` |
| Povinné pole chybí | Přeskočit, `quality_gate_failed=required_field` |
| Text delší než 500 znaků | Zkrátit na 500, pokračovat |

### Hallucination guard
- Pro každou entitu vyžadovat ≥ 2 ověřené zdroje pro status `confirmed`
- Méně než 2 zdroje → status `draft`, neescalovat jako potvrzená data

### Confidence floor
- ConfidenceScore < 0.60 → status `draft`, neprovádět upsert jako finální
- ConfidenceScore 0.60–0.79 → provést upsert, označit jako `needs_review`
- ConfidenceScore ≥ 0.80 → provést upsert jako finální

### Prompt injection guard
- Sanitizovat vstup před vytvořením generation promptu
- Zkrátit text na max 2000 znaků
- Logováno: `prompt_sanitized=true` pokud sanitizace provedena

### Image rate limit
- Max 10 volání create_image za run
- 2s pauza mezi voláními
- Po dosažení limitu: zastavit generaci, pokračovat s upsert existujících dat

### MaxGenerationsPerRun dosažen
- `generated_count >= MaxGenerationsPerRun` → zastavit generaci
- Pokračovat s upsert entit, které byly zpracovány před dosažením limitu

### Failure budget
- Pokud selhání > 20 % z celkového počtu pokusů → STOP generace
- Eskalace na `agent-alerts`
- Zpráva: "Failure budget překročen: {failures}/{total} selhání"
- Upsert pro již vygenerované entity stále probíhá

### Generace selhala — 1. pokus
- Zopakovat s upraveným promptem (1 retry)

### Generace selhala — 2. pokus
- Přeskočit entitu
- Logováno: `generation_failed=true, entity={id}`

### Entity conflict resolution
- Více zdrojů pro stejnou entitu → vyšší ConfidenceScore vítězí
- Oba ConfidenceScore > 0.80 → vložit do ManualReviewQueue
- Zpráva: "Konflikt entit — manuální review: {entity_id}"

### ManualReviewQueue
- Entity s konfliktem (oba > 0.80) čekají na operátorské rozhodnutí
- Nezapsány do hlavní tabulky, jen do ManualReviewQueue

### DryRun mode
- `DryRun=true` → create_image volán, ale URL se neukládá do DB
- Chat výstup označen: "[DRY-RUN]"
- Vygenerované obrázky jsou k dispozici v chatu pro vizuální kontrolu

### DiscoveryQueue prázdná
- Žádné položky od Collector agenta
- Pokračovat s regulárním výběrem entit dle coverage analysis

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT upsertován jako success=false

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Generace OK | `agent-runs` | default |
| Failure budget překročen | `agent-alerts` | high |
| Entity conflict → ManualReviewQueue | `agent-alerts` | high |
| capability_missing("create_image") | `agent-alerts` | high |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `ImageColumn` | sloupec pro URL obrázku — nikdy nepřepisovat pokud vyplněn |
| `MaxPerRun` | max entit ke zpracování za run (výchozí 10) |
| `MaxGenerationsPerRun` | max volání create_image za run (výchozí 50) |
| `quality gate` | validace entity před generací (name, confidence, type, required fields) |
| `hallucination guard` | ≥ 2 zdroje pro status confirmed |
| `confidence floor` | ConfidenceScore < 0.60 → draft status |
| `prompt injection guard` | sanitizace vstupu, max 2000 znaků |
| `image rate limit` | max 10 create_image/run + 2s pauza |
| `failure budget` | > 20 % selhání → STOP generace |
| `contextual batch` | skupiny dle sport/liga/sezóna, max 10 per batch |
| `entity conflict resolution` | vyšší ConfidenceScore vítězí; oba > 0.80 → ManualReviewQueue |
| `capability_missing` | create_image nedostupný (Claude agenti) |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — config soubory
- **API:** create_image (OpenAI DALL-E nebo ekvivalent — jen ChatGPT agenti)
- **Tabulky DB (čtení):** `TargetTables`, `DiscoveryQueue`
- **Tabulky DB (zápis):** `TargetTables` (ImageColumn), `AgentRunReports`, `AgentSchedules`, `ManualReviewQueue`
- **MCP nástroje:** `run_select_sql`, `find_records`, `upsert_record`, `send_notification`, `read_file_content`
