# Governance Monthly Review — srpen 2026

**Datum:** 2026-08-01 (analýza), aktualizováno 2026-08-08 (kontrola stavu repa)
**Aktuální verze (versions.json):** 11.2.0 — **commitnutá** (`feat: governance 11.2.0 — bump Skills na 11.2.0, SimulateReal 1.4.0, mcp-sportreal aktualizace`, 2026-08-03).

## Poznámka k repu

V době psaní analýzy (2026-08-01) byla 11.2.0 ještě necommitnutý WIP v pracovním adresáři. Mezitím (2026-08-03) byla commitnuta. Obsahové závěry review níže se nemění — vycházejí ze stejného obsahu promptů, který byl následně commitnut beze změn relevantních k tomuto reviewu.

---

## Kritické změny (nutná aktualizace promptů)

Žádné. Nic z nalezených novinek nedělá současné instrukce v promptech aktivně nesprávnými nebo nebezpečnými.

## Doporučené změny (zlepšení)

1. **MCP specifikace 2026-07-28 — stateless protokol, Tasks extension, zrušení `Mcp-Session-Id`**
   Dne 28. 7. 2026 vyšla nová verze MCP specifikace (blog.modelcontextprotocol.io/posts/2026-07-28) — nejvýznamnější změna od zavedení autorizace: protokol je nově bezstavový na úrovni protokolu (žádné `Mcp-Session-Id`), přidán Tasks extension (task handle + `tasks/get`/`tasks/update`/`tasks/cancel`), MCP Apps (interaktivní HTML UI v sandboxed iframe), header-based routing, cacheable list results.
   Promty (CatalogPrompt.txt řádek 1909, 282; ManagerPrompt.txt řádek 2890) už zmiňují "MCP konektor = stateless HTTP sessions" a "OČEKÁVANÉ CHOVÁNÍ s MCP stateless konektorem" — to ale odkazuje na vlastní implementační vzor VO2QNAPDB konektorů, ne nutně na formální spec. **Doporučení:** ověřit, jestli `mcp-sportreal/server.js` a ostatní VO2QNAPDB* MCP servery používají SDK verzi kompatibilní s 2026-07-28 spec (zejména pokud SDK dřív spoléhal na `Mcp-Session-Id` header) — riziko breaking change při přechodu klientů (ChatGPT connectors) na novou spec verzi. Toto je spíš úkol pro technickou implementaci MCP serverů než pro text promptů.

2. **Custom GPTs na cestě k deprecation pro Business/Enterprise/Edu/Teachers plány**
   OpenAI oznámilo 22. 4. 2026, že Custom GPTs se pro tyto tiery postupně nahrazují Workspace Agents (bez pevného data nucené migrace, chystá se one-click konverzní nástroj, zatím nevydán). Promty už zmiňují Workspace Agents pro auto-scheduling na Business/Enterprise ("duben 2026"), ale nezmiňují, že samotný Custom GPT wrapper (ne jen scheduling) je na deprecation cestě pro tyto tiery. **Doporučení:** pokud některý z Manager/Catalog/Importer/Collector/Generator/Checker agentů běží pod Business/Enterprise účtem, přidat poznámku do ManualSelfUpdate.txt sledovat vydání migračního nástroje.

## Informativní novinky (jen pro přehled, žádná akce)

- **GPT-5.6 (Sol/Terra/Luna):** GA 9.–10. 7. 2026, API context window potvrzen na 1 050 000 tokenů (promty uvádí "až 1M+" — v pořádku), Enterprise ChatGPT UI tier 1,5M tokenů. Již zapracováno v promptech.
- **ChatGPT Scheduled Tasks redesign:** od 17. 6. 2026 nová "Scheduled" stránka v sidebaru, pohlcuje Pulse (retired ~1. 7. 2026), tasky nově mohou zasahovat do připojených appek. Nemění závěr "ChatGPT Tasks Custom GPTs nepodporuje" — Custom GPTs stále nejsou plnohodnotně podporované scheduled tasky.
- **ChatGPT Custom Instructions limit 1500→5000 znaků (15. 7. 2026):** týká se osobního nastavení Settings→Personalization, NE Instructions pole Custom GPT builderu (jiný mechanismus/limit) — nerelevantní pro governance prompty.
- **OpenAI plugin directory (9. 7. 2026):** app directory sloučen do plugin directory sdíleného ChatGPT/Codex — informativní, nemá dopad na Custom GPT agenty postavené na starém modelu.
- **Anthropic Claude Opus 5 / Sonnet 5 (24. 7. 2026):** nové modely, 1M token context, effort ladder (low/medium/high/xhigh/max) — nerelevantní, governance prompty cílí na GPT/ChatGPT platformu, ne Claude.
- **Group chat deprecation, Academic Researchers access, Computer Use na Windows:** bez dopadu na tyto governance agenty.

## Závěr

Žádná kritická aktualizace promptů není potřeba. **11.2.0 (nyní commitnutá) zůstává aktuální** a už z velké části pokrývá nedávné platformní novinky (GPT-5.6, Custom GPT scheduling limity, stateless MCP vzor). Jediné doporučení pro příští verzi: přidat poznámku o kompatibilitě MCP serverů se spec 2026-07-28 a sledovat Custom GPT → Workspace Agents migrační nástroj. Navrhovaná verze při zapracování doporučení: **11.2.1** (drobné doplnění, ne breaking).
