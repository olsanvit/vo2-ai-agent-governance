# vo2-governance 9.0.0

Released: 2026-06-09

## Přehled

Verze 9.0.0 unifikuje runtime governance všech 6 typů agentů (Catalog, Manager, Generator,
Checker, Collector, Importer) na společnou sadu pravidel. Opravuje opakované degraded/blocked
stavy způsobené nekonzistentními instrukcemi, chybným Drive folder ID a chybějícím
bootstrapem per-agent souborů.

## Breaking changes

Žádné — všechny změny jsou additive/patch. Existující agenti pokračují bez nutnosti
manuální migrace.

## Co je nového

### Startup & Canonical source (7.x → 9.0.0)

- **Gitea-first** canonical source: Gitea → Drive fallback → DB cache → bootstrap
  (commit `ecbf886`)
- **Prompt Cache Protocol**: agent porovná verze před stažením celého souboru
- **SportDisciplines**: Manager agenti načítají disciplíny z DB po identifikaci sportu
  (commit `d31ce75`)
- **Drive fileId no-store rule**: NIKDY neukládat fileId, vždy `search_files` by name
- **AgentSchedules**: conflict window sjednocen na ±1 min (bylo ±15 min v Quick Reference)

### Per-agent soubory

- **Bootstrap chybějícího souboru**: `baseline-catalog-file-manager` a
  `manager-baseline-file-manager` nyní automaticky vytvoří `{AgentName}_entities.txt`
  pokud soubor neexistuje (SELECT COUNT(*) → create_file s defaultními hodnotami)
- **Drive self-test**: oba baseline skills ověří `create-with-parent` schopnost na startu
- Pokud Drive write selže: `capability_missing("drive_create_with_parent")` + degraded
  (ne blocked)
- Unified `_error.txt` (singular) — odstraněna duplicita `_errors.txt` vs `_error.txt`

### Formáty souborů (canonical)

```
{AgentName}_entities.txt:  ImportantScore | TableName | Description | RowCount | LastPopulated | Status
{AgentName}_names.txt:     EntityName | EntityType | PriorityScore | Status | Coverage | LastProcessed | Notes
{AgentName}_urls.txt:      URL | SourceTier | ReliabilityScore | EntityType | LastChecked | Status | Notes
{AgentName}_error.txt:     ProblemScore | Category | Description | Timestamp | StepStatus
```

### Readiness gating

- Drive soubory nejsou blocker readiness — chybějící soubor = bootstrap, ne blocked
- Blocked pouze při: prázdné ImportantScore >= 90 tabulce nebo nedostupné DB
- Nový stav: `first_run_init` (ne blocked při prvním spuštění)

### DB write read-back

- Agent nesmí tvrdit zápis bez potvrzení (rowsAffected > 0 nebo SELECT read-back)
- Pokud write vrátí 502: reportovat `no_partial_write_confirmed` (ne partial_success)

### Ntfy

- Pouze přes MCP `send_notification` tool
- Reportovat stav: `sent | skipped_capability_missing | failed_403 | failed_unconfirmed`
- Ntfy failure = reporting degradation (ne blocker datového běhu)

### Calendar

- **NIKDY** nepoužívat text "AI Catalogs" / "AI Managers" / "AI Generators" přímo
  jako `calendar_id` parametr
- Povinný postup: `list_calendars()` → najít CALENDAR_ID → uložit jako proměnnou pro run
- Pokud `list_calendars()` selže: `capability_missing("calendar_list_calendars")` +
  přeskočit Calendar — NEBLOKUJ datový běh

### Memory

- Memory nesmí být canonical source pro prompt, baseline ani provozní stav
- Canonical pořadí: Gitea → Drive → DB cache → bootstrap

### ImporterPrompt: Rollback

- **Opraveno**: `DELETE FROM` nahrazen soft-delete
  `UPDATE SET ImportStatus="rolled_back", IsDeleted=true`
- Přidán read-back confirm po rollbacku
- Hard DELETE je explicitně zakázán

### AgentSchedules

- Conflict window: ±1 minuta (canonical)
- Pokud agent reportuje ±15 min (ze staré verze skilu): uvést obě hodnoty +
  `governance_inconsistency: true` v errors[]

### Finální run report — povinný formát

Každý run report musí obsahovat sekce:
- STARTUP: readiness_status, prompt_status, PromptVersion, SkillsVersion, MCP_VERSION,
  db_ping, skills_count, capability_missing[]
- PRŮBĚH: confirmed_writes, skipped_actions, failed_actions, inferred_findings
- SOUBORY: stav _entities, _names, _urls, _error
- REPORTING: ntfy status, calendar status, db_report status
- DOPORUČENÝ DALŠÍ KROK

### SkillsVersion unifikace

Všechny `*PromptSkills.txt` soubory sjednoceny na 9.0.0:

| Soubor | Předchozí | Nová |
|---|---|---|
| ManagerPromptSkills.txt | 8.8.0 | 9.0.0 |
| CatalogPromptSkills.txt | 8.8.0 | 9.0.0 |
| GeneratorPromptSkills.txt | 8.7.0 | 9.0.0 |
| CollectorPromptSkills.txt | 8.7.0 | 9.0.0 |
| ImporterPromptSkills.txt | 8.7.0 | 9.0.0 |
| CheckerPromptSkills.txt | 8.7.0 | 9.0.0 |

### Drive folder ID (bugfix)

Opraveno špatné folder ID `Tc08a8pQ` → `Tc08a8xQ` v:
- GeneratorPrompt.txt
- CheckerPrompt.txt
- CollectorPrompt.txt (2 výskyty)
- ImporterPrompt.txt

## Soubory se změnami

```
VERSION
releases/vo2-governance-9.0.0.md
CommonCatalog/CatalogPrompt.txt
CommonCatalog/CatalogPromptSkills.txt
CommonCatalog/CheckerPrompt.txt
CommonCatalog/CheckerPromptSkills.txt
CommonCatalog/CollectorPrompt.txt
CommonCatalog/CollectorPromptSkills.txt
CommonCatalog/GeneratorPrompt.txt
CommonCatalog/GeneratorPromptSkills.txt
CommonCatalog/ImporterPrompt.txt
CommonCatalog/ImporterPromptSkills.txt
SportManager/ManagerPrompt.txt
SportManager/ManagerPromptSkills.txt
```

## Validace po vydání

```
☑ žádný prompt neobsahuje folder ID Tc08a8pQ
☑ všechny *PromptSkills.txt mají SkillsVersion: 9.0.0
☑ VERSION = 9.0.0
☑ žádný ±15 min v Quick Reference sekcích
☑ žádné DELETE v Importer rollback
☑ calendar_id vždy přes list_calendars(), ne hardcoded string
☑ baseline-file-manager bootstrap přítomen v Manager + Catalog skills
```
