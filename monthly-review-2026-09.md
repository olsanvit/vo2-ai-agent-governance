# Měsíční review governance promptů — 2026-09

Datum: 2026-09-24
Rozsah: web research posledních ~35 dní (cca 20.8.–24.9.2026), porovnáno s `governance/versions.json` a hlavičkami `ManagerPrompt.txt` / `CatalogPrompt.txt` / `ImporterPrompt.txt`.

**Aktuální stav (versions.json):** všechny agentní prompty na `12.0.2` (SimulateRealImporterPrompt `12.0.1`, MonitorPrompt `12.1.0`), Skills na `11.5.0`, SharedGovernanceCore `12.1.0`, compatibility.json `v12.1.0` (aktualizováno 2026-09-21).

Hlavičky promptů deklarují: `ModelMin: GPT-4.1 | ClaudeMin: claude-sonnet-4-6`, `ModelRecommended: GPT-5+ | ClaudeRecommended: claude-opus-5`, `Runtime: ChatGPT Custom GPT (manuální/scheduled) | Claude Cloud Routine (CCR, automatický cron)`.

Pouze research a návrh — žádné soubory v tomto běhu nebyly měněny, změny provede uživatel ručně.

---

## Kritické změny

### 1. OpenAI ruší Custom GPTs — dopad na ChatGPT runtime větev všech 10 typů agentů
OpenAI 11.9.2026 oznámilo retirement Custom GPTs napříč ChatGPT plány s migrací na "plugins":
- **Tvorba nových Custom GPTs končí 25.9.2026 — tj. zítra.**
- Existující Custom GPTs přestanou běžet **11.12.2026**.
- Migrace na plugins nezaručuje 1:1 přenos referenčních souborů, šablon ani nástrojů — OpenAI doporučuje před migrací zrevidovat závislé GPT, vlastníky a přístupy.

Každý governance prompt (`ManagerPrompt`, `CatalogPrompt`, `ImporterPrompt`, ... viz hlavičky Ch.1) deklaruje `Runtime: ChatGPT Custom GPT (manuální/scheduled) | Claude Cloud Routine (CCR, automatický cron)`. Pokud se v produkci reálně používá ChatGPT Custom GPT runtime pro některého z 10 typů agentů (Manager/Catalog/Importer/Collector/Checker/Generator/Monitor/Analyzer/Optimizer/SimulateRealImporter), přestane k 11.12.2026 fungovat, dokud nebude nahrazen pluginem nebo úplně vyřazen ve prospěch CCR.

→ Vyžaduje rozhodnutí uživatele: (a) migrovat dotčené agenty na OpenAI plugins před 11.12.2026, nebo (b) formálně vyřadit ChatGPT Custom GPT jako podporovaný runtime a aktualizovat `Runtime:` řádek + `PlatformAddendum_ChatGPT.txt` napříč prompty. Obojí je architektonická změna, ne textová oprava — nedoporučuji provést automaticky.

---

## Doporučené

### 1. Claude Opus 5.5 (vydáno 22.9.2026) — kandidát na nový `ClaudeRecommended`
Anthropic vydal Claude Opus 5.5: výkon na úrovni Fable 5.1 na většině úloh, ale o 40 % levnější provoz než Opus 5; 1M token kontext, 128K max output, always-on adaptive thinking. Prompty aktuálně doporučují `claude-opus-5`. Vzhledem k `EffortNote: Claude — vždy high effort` (Manager/Importer) a komplexitě agentů je Opus 5.5 přímočará kandidátní náhrada za nižší cenu při srovnatelném/lepším výkonu.

→ Navrhované minor verze: bump `ModelRecommended`/`ClaudeRecommended` na `claude-opus-5.5` v hlavičkách všech 10 promptů + odpovídající poznámka v `versions.json`/`compatibility.json`. `ClaudeMin: claude-sonnet-4-6` zůstává jako podlaha v pořádku (Sonnet 5 i Opus 5.5 jsou nad ním).

### 2. MCP jako "first-class access channel" — posílení observability
Aktuální odvětvová governance guidance (NIST SP 1353 draft 3.9.2026, oborové zdroje) zdůrazňuje: MCP se stává standardním rozhraním agent→nástroj a je třeba k němu přistupovat se stejnou přísností jako k API gateway/network access control (least privilege, end-to-end observability na každé tool volání, budget/rate limit ceilings).

Repo už toto částečně pokrývá (`db_ping`/version-check disciplína, SILENT MODE + ntfy run report, `rate_limit_guard` capability). Chybí explicitní požadavek na auditovatelnost MCP tool volání v `SharedGovernanceCore.txt` (kdo/kdy/jaký MCP tool call, mimo běžný DB run report).

→ Informativní podnět pro `SharedGovernanceCore` — zvážit v příští minor verzi, není urgentní.

---

## Informativní

- **Anthropic Messages API compaction (beta, `compact-2026-09-04`)** — server-side komprese historie konverzace na vyžádání. Potenciálně relevantní pro dlouhoběžící scheduled agenty s `EffortNote: vždy high effort`, ale je to beta a týká se API integrace, ne textu promptů. Sledovat, neimplementovat teď.
- **Auto permission policies pro Managed Agents (Claude Developer Platform)** — server vyhodnocuje každé agent/MCP tool volání a reportuje výsledek v event fields. Zatím neaktuální pro CCR runtime, ale může zjednodušit budoucí permission governance.
- **EU AI Act enforcement + NIST SP 1353 draft** (komentáře do 15.10.2026) — obecný regulatorní kontext, nízká přímá relevance pro tento homelab repo, žádná akce nutná.

---

## Závěr — potřebná nová verze?

**Ano, ale ve dvou různých režimech:**

1. **Kritická/architektonická** (Custom GPT retirement) — vyžaduje rozhodnutí uživatele o budoucnosti ChatGPT runtime větve před 11.12.2026. Neprovádět automaticky; navrhuji nejprve rozhodnout scope (migrace vs. vyřazení), pak promítnout do `Runtime:` řádků a `PlatformAddendum_ChatGPT.txt` jako řízenou major/minor změnu.
2. **Nekritická/kosmetická** (Opus 5.5 doporučení) — vhodný kandidát na patch/minor bump `ModelRecommended` napříč `versions.json` a hlavičkami promptů (např. `12.0.2` → `12.0.3` nebo dle zavedené konvence), bez breaking change.

Žádné soubory nebyly v tomto běhu upraveny — jde čistě o návrh k ručnímu schválení a provedení.
