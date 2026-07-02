# vo2-governance 10.1.0
Released: 2026-07-02

## Přehled
Velká aktualizace governance pro všechny typy agentů. Přidány nové protokoly pro todo/config/notes záložky, anti-hallucination pravidla, hard delete zákaz, dry run aktivace a 12+ nových skills.

## Nové funkce

### Todo/Config/Notes záložky (ve všech Prompt typech)
- `todo` záložka: formát řádků, zpracování pending instrukcí, conflict resolution s canonical governance
- `config` záložka: seznam platných override klíčů (ImportantScore, SLA_hours, MaxEntitiesPerRun, SkipTables, PriorityQueue, DryRun)
- `notes` záložka: read-only kontext, čtení při startupu

### Nová infrastruktura
- AgentVersionRegistry: tracking verzí všech agentů
- ManualReviewQueue / QuarantineQueue / DiscoveryQueue: DB schema definice
- Canonical SourceName registry: povolené hodnoty pro SourceName
- EntityHistory: standardizováno pro všechny typy agentů

### Bezpečnostní pravidla (nová nebo rozšířená)
- Hard delete globální zákaz (DELETE/DROP/TRUNCATE) ve všech Prompt typech
- Anti-hallucination pravidla přidána do Catalog/Checker/Collector/Generator/Importer
- API auth failure protokol (401/403 → okamžité zastavení volání zdroje)
- pg_advisory_lock timeout a stuck_agent_lock detekce

### Operátorské nástroje
- Dry run aktivace přes config záložku (`DryRun: true`) nebo todo záložku
- deprecate_column dvoustupňový protokol (rename → DROP po 30 dnech)
- Ntfy fallback na lokální server (192.168.60.221:8225)
- Self-update detekce každých 24h / každý 6. run

### Nové skills (CatalogPromptSkills.txt)
- agent-entity-sync-manager (sync_agent_entities / get_agent_entities)
- column-deprecation-manager (deprecate_column protokol)
- Celkem: 127 skills

### Opravy z předchozích verzí
- MCP Version: 10.0.18 → 10.1.0
- GeneratorPromptSkills: USM-specifické skills označeny jako domain-specific
- ImporterPromptSkills: Top Eleven povinné skills generalizovány
- CheckerPrompt BLOK 4: Skills ≥ 2 → ≥ 8 (sync s CheckerPromptSkills)
- CollectorPromptSkills baseline-collector-file-manager: 4 taby → 7 tabů
- ManagerPrompt scheduled run: 15 kroků → 18 kroků (oprava počítání)
- CatalogPrompt: odebráno neexistující `update_file_content` z Drive MCP toolů
- Gitea timeout: 15 sekund (explicitní pravidlo)
- Troubleshooting Guide přidán do CatalogPrompt
- Confidence Tier Emoji mapa (✅🟡🟠🔴)

## Verze
- PromptVersion: 10.1.0 (všechny typy)
- SkillsVersion: 10.1.0 (všechny typy)
- MCP_VERSION: 10.1.0
