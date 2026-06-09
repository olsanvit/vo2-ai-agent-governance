# vo2-governance 9.1.0

Released: 2026-06-09

## Přehled

Verze 9.1.0 rozšiřuje bootstrap schopnosti Collector agentů a opravuje Google Calendar
governance v CollectorPrompt. Ostatní agenti dostávají bump verze pro synchronizaci
PromptVersion / SkillsVersion.

## Breaking changes

Žádné — všechny změny jsou additive/patch.

## Co je nového

### CollectorPromptSkills — Explicit BOOTSTRAP (9.1.0)

`baseline-collector-file-manager` nyní obsahuje explicitní BOOTSTRAP proceduru
analogickou s Catalog a Manager agenty (přidáno v 9.0.0):

- `search_files("Collectors")` → folder lookup (ne hardcoded folder ID — respektuje fileId no-store rule)
- `SELECT pg_tables WHERE schemaname='public'` → seed entities s ImportantScore=50 default
- `RowCount z COUNT(*)`, `LastPopulated=now()`
- `create_file({AgentName}_entities.txt, parent_folder_id={folderId}, content=...)`
- Pokud `create_file` selže → `capability_missing("drive_create_with_parent")`, pokračovat **degraded** (ne blocked)
- **DRIVE SELF-TEST** na startu: ověřit `create_file` capability

### CollectorPrompt — Calendar CALENDAR_ID Resolution (9.1.0)

Quick Reference sekce "Google Calendar Integration" opravena:

```
Před (9.0.0):  Kalendář: "AI Collectors"
Po  (9.1.0):   CALENDAR_ID: vždy přes list_calendars() → hledat "AI Collectors"
               NIKDY nepoužívat "AI Collectors" přímo jako calendar_id parametr
               Nenalezen → capability_missing("calendar_list_calendars"), přeskočit tiše
```

Tato oprava sjednocuje CollectorPrompt s pravidlem zavedeným v 9.0.0 pro Catalog a Generator.

### PromptVersion / SkillsVersion — Synchronizace na 9.1.0

Všechny soubory sjednoceny na 9.1.0:

| Soubor | PromptVersion | SkillsVersion |
|---|---|---|
| CatalogPrompt.txt | 9.1.0 | — |
| CatalogPromptSkills.txt | — | 9.1.0 |
| GeneratorPrompt.txt | 9.1.0 | — |
| GeneratorPromptSkills.txt | — | 9.1.0 |
| CollectorPrompt.txt | 9.1.0 | — |
| CollectorPromptSkills.txt | — | 9.1.0 |
| CheckerPrompt.txt | 9.1.0 | — |
| CheckerPromptSkills.txt | — | 9.1.0 |
| ImporterPrompt.txt | 9.1.0 | — |
| ImporterPromptSkills.txt | — | 9.1.0 |
| ManagerPrompt.txt | 9.1.0 | — |
| ManagerPromptSkills.txt | — | 9.1.0 |

## Soubory se změnami

```
VERSION
releases/vo2-governance-9.1.0.md
CommonCatalog/CollectorPrompt.txt         (calendar fix + PromptVersion bump)
CommonCatalog/CollectorPromptSkills.txt   (bootstrap + SkillsVersion bump)
CommonCatalog/CatalogPrompt.txt           (PromptVersion bump)
CommonCatalog/CatalogPromptSkills.txt     (SkillsVersion bump)
CommonCatalog/GeneratorPrompt.txt         (PromptVersion bump)
CommonCatalog/GeneratorPromptSkills.txt   (SkillsVersion bump)
CommonCatalog/CheckerPrompt.txt           (PromptVersion bump)
CommonCatalog/CheckerPromptSkills.txt     (SkillsVersion bump)
CommonCatalog/ImporterPrompt.txt          (PromptVersion bump)
CommonCatalog/ImporterPromptSkills.txt    (SkillsVersion bump)
SportManager/ManagerPrompt.txt            (PromptVersion bump)
SportManager/ManagerPromptSkills.txt      (SkillsVersion bump)
```

## Validace po vydání

```
☑ VERSION = 9.1.0
☑ všechny *PromptSkills.txt mají SkillsVersion: 9.1.0
☑ všechny *Prompt.txt mají PromptVersion: 9.1.0
☑ CollectorPrompt neobsahuje "Kalendář: \"AI Collectors\"" (Direct calendar_id)
☑ baseline-collector-file-manager obsahuje BOOTSTRAP blok
☑ Collector BOOTSTRAP používá search_files("Collectors") místo hardcoded folder ID
```
