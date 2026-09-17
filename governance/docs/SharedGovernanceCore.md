# SharedGovernanceCore — Sdílený základ všech agentů

Verze: **v12.0.0** | Aktualizováno: 2026-09-17

## Co je SharedGovernanceCore

Sdílený soubor (`SharedGovernanceCore.txt`) načítaný jako krok 2b Prompt Cache Protocol.
Definuje pravidla platná pro **VŠECHNY agenty** bez výjimky — bez ohledu na AgentType.

Každý agentní prompt načítá tento soubor jako součást svého startu. Změny v Core se propagují
do všech agentů při jejich nejbližším běhu (přes Prompt Cache Protocol).

## Klíčové sekce v souboru

| Sekce | Popis |
|-------|-------|
| Self-update & verzování | Pravidla pro autonomní patch bump, guard "mám nejnovější", git zápis |
| Prompt Cache Protocol | Krok 2b: DB check → MCP → fallback; canonical vs. cache; write-back |
| Tab protokoly (10.0.3) | Pending tab, Config override klíče, Notes read-only |
| Skill Minimum Protokol | Degraded mode při chybějících skills |
| Data Lineage | CreatedByAgent, LastUpdatedByAgent, DataSource — povinné sloupce |
| Environment Support | prod/dev/staging split, DryRun aktivace |
| Agent Health Reporting | AgentHealthReport upsert na konci každého běhu |
| Prompt Version Pinning | PromptVersionPin tabulka — zablokování automatických upgradů |
| Agent Deprecation Lifecycle | active / deprecated / disabled stavy |
| Source Discovery Protocol | Návrh nových zdrojů operátorovi, tab 'urls' |
| Quality Trend Tracking | TrendDirection, circuit breaker při skóre < 30 |
| Retention Policy | IsArchived, RetentionDays, batch scan každých 30 běhů |
| Cross-agent Deduplication | SharedSourceRegistry, ContentHash check |
| AgentType Detection Registry | Mapování AgentName → AgentType → Prompt → Skills → Drive |
| Runtime Governance | Drive fileId, DB write read-back, Memory, Calendar CALENDAR_ID |
| Eskalace | Povinné ntfy pro všechny neřešené problémy |
| **Ntfy Message Format** | **ZÁVAZNÝ standard — plain text, ne JSON; Telegram relay fix** |
| **Ntfy Topics** | **Mapování topic → Telegram prefix [OK]/[ALERT]** |
| **Structured Log Format** | **JSON-Lines v AgentRunReports.Notes — v12.0.0** |
| **DiscoveryQueue Kontrakt** | **Formální schema s TTL a Status stavovým automatem — v12.0.0** |
| **AgentRunReports rozšíření** | **TokensUsed, EstimatedCostUSD, Token Budget Alert — v12.0.0** |
| **Agent Capability Declaration** | **RequiredCapabilities / OptionalCapabilities v BLOK 1 — v12.0.0** |
| **Rollback Protocol** | **RunMode=rollback, Git history, integrity check — v12.0.0** |
| **Disaster Recovery Protocol** | **DR pořadí priorit pro DB/Drive/MCP/ntfy výpadky — v12.0.0** |

## Protokoly definované v Core

### Advisory lock protokol
Popsán v individuálních prompt souborech (BLOK 1). Core definuje, že lock musí proběhnout
před jakýmkoli DB write. Selhání locku = STOP podmínka.

### Ntfy message format (v12.0.0 fix)
- `title`: plain text, max 60 znaků, začíná emoji
- `message`: plain text, max 200 znaků, pipe-separated hodnoty
- Nikdy JSON objekt jako message — relay script na QNAPu čte `.message` jako plain string
- Telegram relay konstruuje: `"[OK] : {title} | {message}"`

### AgentRunReports schema
Upsert na konci každého běhu. Od v12.0.0 rozšířen o:
- `Notes`: JSON-Lines formát (jeden JSON záznam per řádek)
- `TokensUsed`: odhadovaný počet tokenů
- `EstimatedCostUSD`: TokensUsed * 0.000003

### DiscoveryQueue schema (v12.0.0)
Formální kontrakt pro handoff mezi agenty. Status automat:
`pending` → `processing` → `done` / `failed` / `skipped`
TTL: 7 dní. Agent čte pouze `Status=pending AND ProcessedAt IS NULL`.

### Structured Log Format (v12.0.0)
JSON-Lines v `AgentRunReports.Notes`. Starý prose formát deprecated.
Parser (Analyzer, Monitor) musí přechodně podporovat oba formáty.

### DR Protocol (v12.0.0)
Pořadí priorit: DB (3 pokusy pak STOP) → Drive (cache fallback) → MCP timeout (skip krok) → ntfy (akceptovat, pokračovat).
STOP podmínky: DB > 3 pokusy | Advisory lock selhal | Integrity check failed.

### Rollback Protocol (v12.0.0)
Aktivace přes `RunMode=rollback,targetVersion=X.Y.Z`.
Minimum rollback verze: 11.0.0 (starší = nekompatibilní MCP protokol).

### Capability Declaration (v12.0.0)
Každý agent deklaruje v BLOK 1:
- `RequiredCapabilities`: chybí → STOP + eskalace
- `OptionalCapabilities`: chybí → degraded mode + logovat

## Jak agenti Core načítají

Prompt Cache Protocol (krok 2b) — spouští se při každém startu agenta:

```
1. DB CHECK
   SELECT PromptVersion, Content FROM AgentPromptCache
   WHERE AgentType='SharedGovernanceCore' AND PromptFile='SharedGovernanceCore.txt'

2a. MCP CHECK (jen hlavička — 3 řádky)
    GET https://mcp.vo2info.cz/governance/SharedGovernanceCore.txt

3. ROZHODNUTÍ
   a. cache_version == mcp_version  → použít z DB cache (žádné stahování)
   b. cache_version != mcp_version  → stáhnout plný obsah z MCP
                                    → upsert_record("AgentPromptCache", ...)
                                    → write-back Drive (best-effort)
   c. MCP nedostupný → FALLBACK https://vo2info.cz/governance/SharedGovernanceCore.txt
   c2. vo2info.cz nedostupná → FALLBACK GitHub raw (main branch)
   d. GitHub nedostupný → Drive: read_file_content(...)
   e. Drive nedostupný + cache existuje → použít cache; log "prompt_upgrade_blocked"
   f. Vše nedostupné + cache chybí → bootstrap verze; log warning
```

## Kompatibilita

Viz `compatibility.json` ve stejné složce.

- MCP minimum: 11.0.0
- SharedGovernanceCoreMin: 11.8.0 (pro agenty na < 11.8.0 chybí ntfy plain-text standard)
- Breaking change v12.0.0: JSON-Lines log formát, DiscoveryQueue kontrakt, Capability Declaration,
  DR Protocol, Rollback Protocol, Token Budget Tracking, ntfy plain-text standard

## Soubory

| Soubor | Popis |
|--------|-------|
| `SharedGovernanceCore.txt` | Zdrojový soubor (načítán agenty) |
| `compatibility.json` | Matice kompatibility verzí promptů s Core a Skills |
| `docs/SharedGovernanceCore.md` | Tento dokument — přehled a referenční dokumentace |
| `versions.json` | Zrcadlo verzí všech prompt souborů |
