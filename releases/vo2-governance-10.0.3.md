# vo2-ai-agent-governance 10.0.3

Released: 2026-06-30

## Nové funkce

### Tři nové taby ve všech master spreadsheetech

Každý agent nyní při vytváření nebo obnově master spreadsheet přidá 3 nové taby:

| Tab | Obsah | Práce agenta |
|-----|-------|--------------|
| **todo** | Instrukce a úkoly pro agenta — status, priority, datum, kategorie, text, výsledek | Agent čte pending řádky při startu, zpracuje je a zapíše Status=done/failed + Result |
| **notes** | Kontextové poznámky od správce — téma, text, datum | Jen čtení — agent nikdy nepíše do notes |
| **config** | Přepisy governance hodnot per-agent — klíč, hodnota, popis | Agent načte při startu a přepíše výchozí hodnoty |

### Startup kroky pro nové taby

**CatalogPrompt** — nové kroky 14b/14c/14d po stávajícím kroku 14:
- **14b (todo)**: Načíst pending řádky, zpracovat jako instrukce, aktualizovat Status + Result
- **14c (notes)**: Načíst jako read-only kontext
- **14d (config)**: Načíst přepisy a aplikovat (ImportantScore, SLA, MaxEntitiesPerRun, SkipTables, PriorityQueue)

**ManagerPrompt** — nové kroky 8b2/8b3/8b4 po stávajícím kroku 8b (urls):
- **8b2 (todo)**: Identická logika jako 14b v CatalogPrompt
- **8b3 (notes)**: Read-only kontext
- **8b4 (config)**: Přepisy (ImportantScore, SLA, MaxMatchesPerRun, SkipLeagues, PriorityQueue)

### DUPLICATE-GUARD a 403 recovery — 7 tabů místo 4

Při vytváření nebo obnově master spreadsheet se nyní vytvářejí 4 původní + 3 nové taby s headers:
- `entities` | `names` | `urls` | `error` | **`todo`** | **`notes`** | **`config`**

Týká se:
- DUPLICATE-GUARD sekce v CatalogPrompt
- 403 recovery v CatalogPrompt (Catalogs folder: `1-vX64o8hs25FPkAVH52P9lXUhLCC1FjH`)
- DUPLICATE-GUARD sekce v ManagerPrompt
- 403 recovery v ManagerPrompt (Managers folder: `1lEvffJ-rjdExCwMWxmWM7PchnKkGTGUO`)

### ManualSelfUpdate.txt — aktualizováno na 10.0.3

Template pro ruční aktualizaci agentů odkazuje na verzi 10.0.3.

## Přehled změn

Tato verze navazuje na opravy z 10.0.2 a přidává mechanismus pro asynchronní komunikaci správce → agent bez nutnosti přerušovat agentův run. Správce zapíše instrukci do tabulky `todo`, agent ji zpracuje při příštím startu. Tab `config` umožňuje přepsat governance defaults per-agent bez úpravy governance souborů.

## Soubory změněny

- `governance/CatalogPrompt.txt` (PromptVersion: 10.0.3)
- `governance/CatalogPromptSkills.txt` (SkillsVersion: 10.0.3)
- `governance/ManagerPrompt.txt` (PromptVersion: 10.0.3)
- `governance/ManagerPromptSkills.txt` (SkillsVersion: 10.0.3)
- `governance/CheckerPrompt.txt` (PromptVersion: 10.0.3)
- `governance/CheckerPromptSkills.txt` (SkillsVersion: 10.0.3)
- `governance/CollectorPrompt.txt` (PromptVersion: 10.0.3)
- `governance/CollectorPromptSkills.txt` (SkillsVersion: 10.0.3)
- `governance/GeneratorPrompt.txt` (PromptVersion: 10.0.3)
- `governance/GeneratorPromptSkills.txt` (SkillsVersion: 10.0.3)
- `governance/ImporterPrompt.txt` (PromptVersion: 10.0.3)
- `governance/ImporterPromptSkills.txt` (SkillsVersion: 10.0.3)
- `governance/ManualSelfUpdate.txt` (TemplateVersion: 10.0.3)
- `VERSION` (10.0.3)
- `releases/vo2-governance-10.0.3.md` (tento soubor)
