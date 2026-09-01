# Governance Monthly Review — Září 2026

**Datum reviews:** 2026-09-01
**Období pokryté researchem:** cca 28. 7. – 1. 9. 2026 (35 dní)
**Aktuální verze promptů:** ManagerPrompt 11.2.3 · CatalogPrompt/ImporterPrompt/CollectorPrompt/GeneratorPrompt/CheckerPrompt 11.2.1 (Skills 11.2.0, generováno 2026-07-30) · SimulateRealImporterPrompt 1.4.0

## Shrnutí

Governance prompty jsou aktuální. Už reflektují GPT-5.6 (Sol/Terra/Luna, dostupné od 9. 7. 2026), Claude Sonnet 5 / Opus 5 a MCP stateless model (ManagerPrompt.txt:2979, CatalogPrompt.txt:1979: "MCP konektor = stateless HTTP sessions"). Za sledované období nebyla nalezena žádná novinka vyžadující okamžitou (kritickou) změnu.

## Kritické změny

**Žádné.** Nenalezena žádná novinka, která by rozbíjela stávající governance pravidla nebo runtime chování agentů.

## Doporučené změny

1. **MCP spec 2026-07-28 — deprecation Roots/Sampling/Logging (SEP-2577).**
   Nová specifikace MCP (vydaná 28. 7. 2026) formálně deprecatuje Roots, Sampling a Logging capabilities a přesouvá Tasks do samostatné extension. Běží 12měsíční grace period (do ~7/2027), wire-level chování se zatím nemění.
   *Dopad na nás:* Ověřil jsem `mcp-image/`, `mcp-sportreal/` a `server.js` — žádný z našich MCP serverů tyto capabilities nevyužívá, takže není nutná okamžitá akce. Doporučuji jen poznámku do CatalogPrompt/ManagerPrompt sekce o MCP stateless konektorech, že Roots/Sampling/Logging jsou deprecated (informační poznámka pro budoucí MCP tooling, ne urgentní).

2. **WebMCP (OpenAI, srpen 2026).** Nový standard umožňující webům nabízet AI agentům strukturované akce přímo přes prohlíženou stránku/session (alternativa ke scrapingu). Relevantní pro Collector/Importer agenty, které dnes stahují data přes screenshoty/scraping. Nejde o nic urgentního, ale stojí za to sledovat, zda zdrojové weby (sportovní data) WebMCP začnou nabízet — mohlo by to zjednodušit CollectorPrompt/ImporterPrompt pipeline.

3. **ChatGPT Custom GPTs → Workspace Agents (pokračující migrace).** OpenAI dále rozvíjí Workspace Agents (Admin plugin, offline/scheduled run v cloudu přes Codex, Slack integrace) jako náhradu Custom GPTs. Custom GPTs zůstávají prozatím funkční pro individuální účty, ale trend k postupnému útlumu pokračuje. Naše prompty (`Runtime: ChatGPT Custom GPT (manuální/scheduled) | Claude Cloud Routine`) na tom zatím nic nemění, ale je to kandidát na středně-dlouhodobé sledování — případný přechod na Workspace Agents runtime by mohl nahradit ChatGPT větev.

## Informativní novinky

- **GPT-5.6 (Sol/Terra/Luna)** — již referencováno v prompt hlavičkách (9. 7. 2026), 21. 8. 2026 OpenAI snížilo cenu Sol o 20 % na 3 měsíce. Bez dopadu na governance text.
- **Claude Opus 5** — plná effort-ladder (low/medium/high/xhigh/max); mid-conversation tool changes (beta); fallback `"default"` mode (beta); nový `anthropic-workspace-id` response header. Naše prompty tyto beta funkce nepoužívají, žádná akce.
- **Claude Sonnet 5 pricing** — plánované zvýšení ceny k 1. 9. 2026 bylo zrušeno, cena zůstává na intro sazbě ($2/$10 MTok). Dobrá zpráva z hlediska nákladů, bez dopadu na governance text.
- **Claude Opus 4.1** — deprecated, retirement 5. 8. 2026, doporučená migrace na Opus 4.8. Naše prompty žádný model `opus-4.1` nereferencují — bez dopadu.
- **Atlas (OpenAI browser)** — deprecation od 9. 8. 2026 (nahrazeno agentic capabilities přímo v ChatGPT/Codex). V repozitáři není žádná reference na Atlas — bez dopadu.
- **MCP roadmap (22. 8. 2026)** — Core Maintainers zveřejnili roadmapu pro transport evolution, agent-to-agent komunikaci, governance maturitu (Contributor Ladder, Working Groups) a enterprise readiness. Nic konkrétního k akci, jen dlouhodobý směr k monitoringu.

## Závěr

**Nová verze governance promptů není tento měsíc potřeba.** Žádná kritická ani urgentní změna nebyla nalezena, prompty jsou aktuální vůči modelové i MCP krajině. Doporučuji zařadit body 1–3 z "Doporučené změny" jako nízkoprioritní backlog položky pro příští review (MCP deprecation poznámka, WebMCP sledování, ChatGPT runtime migrace).
