# ImporterPrompt — dokumentace

**Verze:** 11.8.0  
**AgentType:** Importer  
**Soubor:** `governance/ImporterPrompt.txt` (882 řádků)

---

## Co dělá

Importer agent čte obrázky (screenshoty) ze zdrojové složky na Google Drive, extrahuje z nich strukturovaná data pomocí OCR, validuje je a ukládá do DB. Zpracovává i položky z DiscoveryQueue od Checker agenta (checker_handoff). Po úspěšném zpracování přesouvá soubory do složky ProcessedFolder. Zdrojové soubory nikdy nesmaže — pouze přesouvá. Rollback provádí přes soft delete (IsDeleted=true).

---

## Konfigurace

Konfigurace se načítá ze souboru `{AgentName}_config.txt` na Google Drive ve složce `/Prompts/Importers/`.

| Parametr | Výchozí | Popis |
|---|---|---|
| `SourceFolder` | — | ID Drive složky se zdrojovými soubory |
| `ProcessedFolder` | — | ID Drive složky pro zpracované soubory |
| `SubfolderScheme` | none | `none` / `by_season` / `by_date` / `custom` |
| `MaxDuplicateRatio` | 0.30 | max podíl duplikátů (30 %) před zastavením |
| `MaxSourceAgeDays` | 7 | max stáří zdrojového souboru (dny) |
| `DryRun` | false | bez zápisů do DB |
| `MaxParallel` | 3 | max paralelní OCR parsovacích vláken |

---

## Průběh (Happy Path)

**Startup sekvence:**

1. DB PING — ověření dostupnosti TargetDB
2. PROMPT CACHE PROTOCOL — MCP → vo2info.cz → GitHub → Drive → DB cache → bootstrap
3. SKILLS CACHE PROTOCOL — načtení ImporterPromptSkills
4. CONFIG — načtení `{AgentName}_config.txt` z Drive
5. MAPPING FILE LOAD — načtení `{AgentName}_mapping.txt` (extrakční pravidla per screenshot typ)
6. AGENT SCHEDULES — přehled plánů z AgentSchedules
7. READINESS — klasifikace stavu
8. AGENT HEALTH REPORT — ntfy topic `agent-health`
9. LOCK — `pg_try_advisory_lock` per-agent

**Run sekvence:**

0. SELF-AUDIT (podmínka: explicitní žádost | první run | každých 30 runů)
1. SCHEMA MIGRATION GUARD — ověření, že cílové tabulky mají ImportedAt + ImportedBy sloupce
2. DISCOVERY QUEUE CHECK — načtení checker_handoff položek
3. SOURCE FILE LISTING — seznam souborů v SourceFolder (filtr dle MaxSourceAgeDays)
4. DUPLICATE DETECTION — SHA256 hash souboru vs. ScreenshotImportLog
5. OCR PARSING — extrakce dat dle mapping.txt (max MaxParallel vláken paralelně)
6. VALIDATION — validace extrahovaných dat
7. DB WRITE — upsert do cílových tabulek (vždy sekvenčně, ne paralelně)
8. POST-IMPORT VALIDATION — ověření upsertovaných dat v DB
9. FILE MOVE — přesun do ProcessedFolder (jen pokud všechny 4 podmínky splněny)
10. IMPORT AUDIT TRAIL — záznam do ScreenshotImportLog
11. RUN REPORT — upsert do AgentRunReports
12. SCHEDULE UPDATE — upsert do AgentSchedules
13. CALENDAR EVENT — příští plánovaný run
14. NOTIFICATION — ntfy dle výsledku
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
- Výchozí hodnoty: MaxDuplicateRatio=0.30, MaxSourceAgeDays=7, DryRun=false, MaxParallel=3
- Varování v run reportu, pokračuje

### Mapping soubor chybí
- `{AgentName}_mapping.txt` nenalezen → nemožné extrahovat data
- Run zastaven, eskalace na `agent-errors`
- Zpráva: "Mapping soubor chybí — import nelze provést"

### Schema migration guard — ImportedAt nebo ImportedBy chybí
- Povinné sloupce nejsou v cílové tabulce
- Provést aditivní schema patch: `ALTER TABLE ADD COLUMN IF NOT EXISTS ImportedAt TIMESTAMPTZ; ALTER TABLE ADD COLUMN IF NOT EXISTS ImportedBy TEXT`
- Logováno: `schema_migration_applied=true`

### Zdrojový soubor příliš starý (> MaxSourceAgeDays)
- Přeskočit soubor, logovat: `source_too_old={filename}`

### Zdrojová složka prázdná
- Žádné nové soubory ke zpracování
- Run ukončen s success=true, items_processed=0

### Duplicitní soubor (SHA256 hash)
- Hash existuje v ScreenshotImportLog → přeskočit
- Logováno: `duplicate_skipped={filename}`

### MaxDuplicateRatio překročen (> 30 %)
- Zastavit zpracování dalších souborů
- Eskalace na `agent-alerts`
- Zpráva: "Příliš mnoho duplikátů: {ratio}% — kontrola zdrojové složky doporučena"

### OCR — kategorie spolehlivosti

| Spolehlivost | Rozsah | Akce |
|---|---|---|
| Clear | 90–100 % | Zpracovat normálně |
| Probable | 70–89 % | Zpracovat s příznakem `ocr_probable=true` |
| Uncertain | 50–69 % | Zpracovat s příznakem `ocr_uncertain=true`, doporučit review |
| Skip | < 50 % | Přeskočit, logovat jako `ocr_too_low` |

### OCR selhalo (< 50 % spolehlivost)
- Soubor přeskočen, nepřesunut
- Logováno: `ocr_failed={filename}`
- Soubor zůstává v SourceFolder

### Encoding detection
- Automatická detekce kódování souboru
- Při chybě detekce → přeskočit soubor, logovat: `encoding_detection_failed`

### Idempotency key
- MD5 hash (source_url + date) jako idempotency key
- Při duplicitním importu stejného záznamu → UPDATE místo INSERT (upsert)

### Validace extrahovaných dat — selhání
- Povinná pole chybí → odmítnout záznam
- Logováno: `validation_failed={field}`
- Soubor nepřesunut

### DB write selhal (upsert chyba)
- Rollback: soft delete přes IsDeleted=true dle RunGuid (nikdy DELETE)
- Logováno: `db_write_failed, rollback_applied`
- Eskalace na `agent-errors` pokud selhání > 10 % batch

### Post-import validation selhala
- Upsertovaný záznam nelze najít v DB po zápisu
- Rollback přes IsDeleted=true
- Logováno: `post_import_validation_failed`

### File move — 4 podmínky (všechny musí být splněny)
1. Data úspěšně extrahována
2. DB write OK
3. Post-import validace OK
4. Není potřeba manuální review

Pokud kterákoli podmínka nesplněna → soubor zůstává v SourceFolder, nezpracovaný.

### Large batch chunking
- Příliš velká dávka → zpracovat v chuncích
- Každý chunk ukončen DB write + validation před dalším chunkem

### Parallel parsing vs. sequential DB write
- OCR parsing: max MaxParallel (výchozí 3) vláken paralelně
- DB write: vždy sekvenčně (jeden záznam po druhém) — zabraňuje race conditions

### Checker feedback loop
- Po importu: notifikovat Checker agenta přes DiscoveryQueue o výsledku
- Checker může verifikovat čerstvost importovaných dat

### Data freshness guarantee
- ImportedAt povinný → záznamy vždy mají timestamp importu
- Checker může ověřit freshness dle ImportedAt

### DryRun mode
- `DryRun=true` → OCR probíhá, ale žádné DB write ani file move
- Výsledky extrakce zobrazeny v chatu
- ScreenshotImportLog není aktualizován
- Chat výstup označen: "[DRY-RUN]"

### Import audit trail — povinná pole
- `ImportedAt` (timestamp) + `ImportedBy` ({AgentName}) povinné na každém importovaném záznamu
- Záznam bez těchto polí odmítnout

### Run selhal obecně
- ntfy topic `agent-errors`, priority `urgent`
- RUN REPORT upsertován jako success=false

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Startup OK | `agent-health` | default |
| Import OK | `agent-runs` | default |
| Mapping soubor chybí | `agent-errors` | urgent |
| MaxDuplicateRatio překročen | `agent-alerts` | high |
| DB write selhání > 10 % | `agent-errors` | urgent |
| Run selhal | `agent-errors` | urgent |

`agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `SourceFolder` | Drive složka se zdrojovými screenshoty |
| `ProcessedFolder` | Drive složka pro zpracované soubory (přesunuty po úspěchu) |
| `mapping.txt` | extrakční pravidla pro každý typ screenshotu |
| `SHA256 hash` | deduplication zdrojových souborů |
| `OCR confidence` | 90–100 clear / 70–89 probable / 50–69 uncertain / <50 skip |
| `idempotency key` | MD5(source_url + date) — zabrání duplicitnímu importu |
| `MaxDuplicateRatio` | max podíl duplikátů (výchozí 30 %) před zastavením |
| `import audit trail` | ImportedAt + ImportedBy povinné na každém záznamu |
| `rollback` | IsDeleted=true dle RunGuid — nikdy DELETE |
| `4 podmínky file move` | extrakce OK + DB write OK + validace OK + no review needed |
| `MaxParallel` | max paralelní OCR vláken (výchozí 3); DB write vždy sekvenčně |
| `schema migration guard` | ověření ImportedAt + ImportedBy sloupců, aditivní patch |

---

## Závislosti

- **DB:** PostgreSQL na QNAP přes MCP konektory (AIDB, VO2QNAPDB*)
- **Drive:** Google Drive — SourceFolder, ProcessedFolder, config soubory, mapping soubor
- **Tabulky DB (zápis):** cílové tabulky (dle mapping.txt), `AgentRunReports`, `AgentSchedules`, `ScreenshotImportLog`, `DiscoveryQueue`
- **MCP nástroje:** `run_select_sql`, `find_records`, `upsert_record`, `send_notification`, `read_file_content`, `list_files` (Drive), `move_file` (Drive)
