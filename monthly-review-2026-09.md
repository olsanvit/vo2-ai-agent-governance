# Měsíční review governance promptů — 2026-09

Datum: 2026-09-26 (navazující běh; první proběhl 24.9.)
Rozsah: web research posledních ~35 dní (cca 21.8.–26.9.2026), porovnáno s `governance/versions.json` a hlavičkami `ManagerPrompt.txt` / `CatalogPrompt.txt` / `ImporterPrompt.txt`.

**KROK 0 — verze AnalyzerPrompt:** `versions.json` uvádí `AnalyzerPrompt: 12.0.2` → **prompt_status = up-to-date** (odpovídá požadované 12.0.2).

**Aktuální stav (versions.json):** všechny agentní prompty na `12.0.2` (SimulateRealImporterPrompt `12.0.1`, MonitorPrompt `12.1.0`), Skills na `11.5.0`, SharedGovernanceCore `12.1.0`, compatibility.json `v12.1.0` (aktualizováno 2026-09-21).

Hlavičky promptů deklarují: `ModelMin: GPT-4.1 | ClaudeMin: claude-sonnet-4-6`, `ModelRecommended: GPT-5+ | ClaudeRecommended: claude-opus-5`, `Runtime: ChatGPT Custom GPT (manuální/scheduled) | Claude Cloud Routine (CCR, automatický cron)`.

Pouze research a návrh — žádné soubory v tomto běhu nebyly měněny, změny provede uživatel ručně.

---

## Kritické změny

### 1. OpenAI ruší Custom GPTs — dopad na ChatGPT runtime větev všech 10 typů agentů
OpenAI 11.9.2026 oznámilo retirement Custom GPTs napříč ChatGPT plány s migrací na "plugins":
- **Oprava oproti prvnímu reportu z 24.9.:** termín "tvorba nových Custom GPTs končí 25.9." platil jen pro Enterprise/Business/Edu workspace timeline a OpenAI ho **19.9.2026 revidovalo** — konec tvorby nových Custom GPTs v postižených Enterprise workspace je nově **26.10.2026** (migrace tam cílená na 22.9.). Pro osobní účty (Free/Plus/Pro) platí od **16.9.2026** už jen editace existujících GPT, nové se nedají tvořit; ostatní plány "mohou" mít stejný harmonogram, ale FAQ to nezaručuje.
- Existující Custom GPTs přestanou běžet **11.12.2026** (u schválených Enterprise deferrals **11.2.2027**) — tento finální termín se revizí nezměnil.
- Migrace na plugins nezaručuje 1:1 přenos referenčních souborů, šablon ani nástrojů — OpenAI doporučuje před migrací zrevidovat závislé GPT, vlastníky a přístupy.

→ Praktický dopad korekce: méně naléhavé než napsáno 24.9. (žádný "zítřejší" deadline), ale **finální 11.12.2026 pro běh existujících Custom GPTs zůstává v platnosti** a je to stále ta rozhodující lhůta pro tento repo.

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

- **MCP protokol — specifikace 2026-07-28** přinesla přechod na stateless jádro (Multi Round-Trip Requests, header-based routing místo trvalého session spojení), cacheable list results a zpřísněnou autorizaci. Relevantní pro `server.js`/`mcp-image/`/`mcp-sportreal/` jako vlastní MCP server implementace — stojí za ověření, zda aktuální `MCP_VERSION` v `server.js` odpovídá podporovanému rozsahu specifikace, nebo je to jen budoucí sledovaná položka bez okamžité akce.
- **Anthropic Messages API compaction (beta, `compact-2026-09-04`)** — server-side komprese historie konverzace na vyžádání. Potenciálně relevantní pro dlouhoběžící scheduled agenty s `EffortNote: vždy high effort`, ale je to beta a týká se API integrace, ne textu promptů. Sledovat, neimplementovat teď.
- **Auto permission policies pro Managed Agents (Claude Developer Platform)** — server vyhodnocuje každé agent/MCP tool volání a reportuje výsledek v event fields. Zatím neaktuální pro CCR runtime, ale může zjednodušit budoucí permission governance.
- **EU AI Act enforcement + NIST SP 1353 draft** (komentáře do 15.10.2026) — obecný regulatorní kontext, nízká přímá relevance pro tento homelab repo, žádná akce nutná.

---

## Závěr — potřebná nová verze?

**Ano, ale ve dvou různých režimech:**

1. **Kritická/architektonická** (Custom GPT retirement) — vyžaduje rozhodnutí uživatele o budoucnosti ChatGPT runtime větve před 11.12.2026. Neprovádět automaticky; navrhuji nejprve rozhodnout scope (migrace vs. vyřazení), pak promítnout do `Runtime:` řádků a `PlatformAddendum_ChatGPT.txt` jako řízenou major/minor změnu.
2. **Nekritická/kosmetická** (Opus 5.5 doporučení) — vhodný kandidát na patch/minor bump `ModelRecommended` napříč `versions.json` a hlavičkami promptů (např. `12.0.2` → `12.0.3` nebo dle zavedené konvence), bez breaking change.

Žádné soubory nebyly v tomto běhu upraveny — jde čistě o návrh k ručnímu schválení a provedení.

---

## Provozní poznámka k tomuto běhu (26.9.)

Předchozí běh (25.9.) upozornil na literální ntfy admin credential, který skončil v `governance/EscalationProtocol.txt` (commit přidávající soubor byl už na `origin/main`) — hodnota se ukázala jako živá i po přechodu repa na private, protože Gitea zrcadlo je čitelné anonymně.

Mezitím byl problém vyřešen přímo v repu: `EscalationProtocol` je na `main` v `v1.1.0` a místo `curl` + Basic Auth credential nyní veškerou komunikaci s ntfy směruje přes AIDB MCP konektor (žádná hodnota v souboru). `versions.json` to odráží (`EscalationProtocol: "1.1.0"`). Odpovídající commit v `origin/main` historii také nahradil starší stav, ve kterém byla hodnota přítomná — čímž se řeší i obava z předchozího běhu, že zůstane dohledatelná v historii.

Žádná další akce k tomuto bodu není z mé strany potřeba; zmiňuji pro návaznost na report z 25.9.
