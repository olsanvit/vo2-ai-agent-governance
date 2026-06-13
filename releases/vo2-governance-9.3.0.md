# vo2-governance 9.3.0

Released: 2026-06-13

## Summary

Přechod z Drive .txt souborů na Google Sheets pro per-agent tabulková data (entities, names, urls).
Google Sheets umožňují filtrování, řazení a přímou editaci v prohlížeči — oproti .txt souborům.
Chybový log (`_error.txt`) zůstává jako Drive .txt (append-only, není tabulkový).

## Changes

### 1. Version bump: 9.2.0 → 9.3.0
- PromptVersion: 9.3.0 v CatalogPrompt.txt a ManagerPrompt.txt
- MCP_VERSION: 9.3.0 v server.js (byl 9.0.0)
- Agent header: 9.3.0 v obou prompt souborech

### 2. Google Sheets místo Drive .txt — entities, names, urls

**Proč Sheets (ne .txt):**
- entities/names/urls jsou tabulková data — Sheets mají záhlaví, filtrování, řazení
- Operátor může přímo editovat v prohlížeči bez stahování
- Agent může přidat/updatovat konkrétní řádek bez přepisu celého souboru
- error.txt je výjimka — append-only log, .txt je vhodný formát

**Změněné soubory:**
- `{AgentName}_entities.txt` → `{AgentName}_entities` (Google Sheet)
  - Columns: ImportantScore | TableName | Description | RowCount | LastPopulated
  - Folder: /Prompts/Catalogs/ (ID: 1-vX64o8hs25FPkAVH52P9lXUhLCC1FjH) — Catalog agenti
  - Folder: /Prompts/Managers/ (ID: 1lEvffJ-rjdExCwMWxmWM7PchnKkGTGUO) — Manager agenti
- `{AgentName}_names.txt` → `{AgentName}_names` (Google Sheet)
  - Columns: EntityName | coverage | tables | lastProcessed
  - Folder: /Prompts/Names/ (ID: 1-3GkQT-OqVpkaKwLKkgW8jjbWzNN7BYY)
- `{AgentName}_urls.txt` → `{AgentName}_urls` (Google Sheet)
  - Columns: URL | SourceTier | ReliabilityScore | EntityType | LastChecked | Status
  - Folder: /Prompts/Urls/ (ID: 1kYViGZR02wNjr1X0PEqJzBQYmjxobm5U)

**Zachováno jako Drive .txt:**
- `{AgentName}_error.txt` v /Problems/ — beze změny

### 3. Nové Sheets API nástroje v server.js

Přidáno 5 nástrojů (volají Google Sheets API v4, auth přes service account):

| Nástroj | Popis |
|---------|-------|
| `sheets_get_values` | Čte všechny řádky ze Sheetu (vrací array of arrays) |
| `sheets_append_rows` | Appenduje řádky na konec Sheetu |
| `sheets_update_row` | Aktualizuje konkrétní range (A1 notace, napr. Sheet1!A3:E3) |
| `sheets_find_row` | Najde řádek dle hodnoty v sloupci (0-based, case-insensitive) |
| `sheets_create_spreadsheet` | Vytvoří nový Sheet a přesune do Drive složky |

**Konfigurace (env var):**
```
GOOGLE_SERVICE_ACCOUNT_JSON=<base64 nebo raw JSON service account klíče>
```
Service account musí mít:
- Google Sheets API scope: `https://www.googleapis.com/auth/spreadsheets`
- Google Drive scope: `https://www.googleapis.com/auth/drive.file`
- Přístup ke Google Drive složkám (sdílení s email service accountu)

### 4. Aktualizované sekce v CatalogPrompt.txt

- STARTUP SEKVENCE kroky 4, 5, 6 → Sheets workflow
- SCHEDULED RUN kroky 2, 3, 12 → Sheets reference
- KLICOVE MCP NASTROJE → přidána Sheets sekce
- Per-agent Files Management tabulka → Sheets řádky
- Startup runtime kroky 12, 13, 14 → search_files + sheets_get_values
- First Run Protocol krok 4 → sheets_create_spreadsheet + záhlaví
- Self-Audit BLOK 2 verze → 9.3.0
- Self-Audit BLOK 5 → Sheets kontrola místo Drive .txt
- MCP Version → 9.3.0

### 5. Aktualizované sekce v ManagerPrompt.txt

- Startup krok 8, 8a, 8b → Sheets workflow
- Per-agent Files Management tabulka → Sheets řádky
- Google Drive Agent Folder Structure sekce → přejmenována na Google Sheets Agent Data Structure
- Google Drive Sports Baseline Catalog sekce → přejmenována, lifecycle rules aktualizovány
- First Run Protocol krok 4 → sheets_create_spreadsheet + záhlaví
- Self-Audit BLOK 5 → Sheets kontrola
- Self-Audit verze v ntfy zprávě → 9.3.0

## Migration Notes

**Existující agenti s _entities.txt:** Při prvním runu 9.3.0 agent nenajde Sheet (najde .txt).
Postup:
1. Agent spustí search_files → nenajde Sheet → vytvoří nový přes sheets_create_spreadsheet
2. Historická data z .txt je potřeba manuálně překopírovat do nového Sheetu (nebo agent začne fresh)
3. Staré .txt soubory lze po migraci smazat operátorem

**Nová nastavení pro server.js:**
- Přidat `GOOGLE_SERVICE_ACCOUNT_JSON` env var do Docker kontejneru agentsPromptsSkills
- Service account vytvořit v Google Cloud Console, aktivovat Sheets API + Drive API
- Sdílet Drive složky (Catalogs, Managers, Names, Urls) s email service accountu

## Files Modified

- CommonCatalog/CatalogPrompt.txt
- SportManager/ManagerPrompt.txt
- server.js
- VERSION (9.2.0 → 9.3.0)

## Backward Compatibility

⚠️ Partial breaking change: per-agent soubory entities/names/urls mění formát z .txt na Google Sheet.
✅ error.txt zachován jako Drive .txt — beze změny.
✅ Drive folder IDs beze změny — stejné složky, jiný typ souboru.
✅ search_files stále funguje pro nalezení Sheets podle názvu v Drive složce.
✅ Sheets API nástroje jsou additive — starý agent bez GOOGLE_SERVICE_ACCOUNT_JSON dostane jasnou chybu.
