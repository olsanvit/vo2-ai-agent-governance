# vo2-governance 10.0.2

Released: 2026-06-30

## Změny

### GAP 1 + 4 — selfUpdate zapisuje zpět na Drive (CatalogPrompt + ManagerPrompt)
Po úspěšném stažení nového promptu z Gitea agent nově zapíše aktualizovaný obsah zpět do Drive governance složky (prompt i skills soubor). Drive fallback tak zůstane vždy aktuální — při příštím startu kdy je Gitea/GitHub nedostupná agent nenačte stale verzi z Drive, ale aktuální.

### GAP 2 — DB ping retry 3× 60s místo 5× 3s (CatalogPrompt + ManagerPrompt)
Startup DB ping nově opakuje max 3× s 60s prodlevou (celkem ~3 minuty) místo původních 5× 3s (15 sekund). Odpovídá reálné době restartu QNAP/serveru. Agenti co se spustili při restartu infrastruktury již nepadají na db_unreachable.

### GAP 3 — Drive 403 na master spreadsheet → automatická obnova (CatalogPrompt + ManagerPrompt)
Pokud service account dostane 403 při čtení master spreadsheet, agent nově automaticky vytvoří nový spreadsheet ve správné složce (dle AgentType), uloží nové SpreadsheetId do AgentCatalog v DB a pokračuje. Eliminuje nutnost ručního sdílení spreadsheet se service accountem pro agenty kteří dostali 403.

### MCP_VERSION decoupling (CatalogPrompt + ManagerPrompt)
Self-audit a version check nově požadují MCP_VERSION >= 10.0.1 (místo == 10.0.1). PromptVersion a MCP_VERSION jsou nezávislé — MCP server se nemění při každém prompt release.

## Soubory změněny
- governance/CatalogPrompt.txt
- governance/ManagerPrompt.txt
- governance/CatalogPromptSkills.txt
- governance/ManagerPromptSkills.txt
- governance/CheckerPrompt.txt
- governance/CollectorPrompt.txt
- governance/GeneratorPrompt.txt
- governance/ImporterPrompt.txt
- governance/CheckerPromptSkills.txt
- governance/CollectorPromptSkills.txt
- governance/GeneratorPromptSkills.txt
- governance/ImporterPromptSkills.txt
- governance/ManualSelfUpdate.txt
- VERSION
