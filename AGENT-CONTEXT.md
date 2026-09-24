# VO2 AI Agent Governance — Agent Context

> Vstupní bod pro agent session. Podrobnosti jsou v `CLAUDE.md`, ten je nadřazený tomuto přehledu.
> Ověřeno 2026-09-23.

---

## Co je projekt

Kanonický repozitář governance promptů pro AI agenty VO2 (homelab vo2info.cz) a runtime MCP serverů.
Není to Blazor projekt — žádné `.razor`, žádné EF migrace, žádný submodul SharedServices.

**Repo:** `github.com/olsanvit/vo2-ai-agent-governance` — **PRIVATE od 2026-09-15** (anonymně 404).
**Větev:** `main`. Zrcadlo: `gitea.vo2info.cz/olsanvit/vo2-ai-agent-governance` (čitelné anonymně).

Repo bylo dřív veřejné a unikly z něj hesla a tokeny; historie byla přepsána a hodnoty rotovány.
Do trackovaných souborů proto nikdy nepatří hesla, tokeny ani connection stringy — jen `${PROMĚNNÁ}`
nebo `process.env.X`. Hlídá to `scripts/check-secrets.sh` v CI. Postup a stav: `docs/2026-09-12-secrets-rotation.md`.

---

## Struktura

```
governance/            28 .txt promptů + versions.json
  <Typ>Prompt.txt      Manager, Catalog, Importer, Collector, Checker, Generator,
  <Typ>PromptSkills.txt  Monitor, Analyzer, Optimizer, SimulateRealImporter
  PlatformAddendum_*.txt  ChatGPT, Claude, Copilot, Gemini, Manus, Perplexity
  SharedGovernanceCore.txt, ManualSelfUpdate.txt
  versions.json        zrcadlo verzí všech promptů (28 záznamů)
server.js              MCP server pro DB AIData (kontejner qnap-game-mcp)
mcp-image/*.js         mcp-mab.js, mcp-usm.js — odvozené MCP servery
mcp-sportreal/         MCP server pro SportReal (read-only)
scripts/               check-secrets.sh, check-versions.py, rotační a provozní skripty pro QNAP
docs/                  prompts/, runbooky (rotace, deploy)
audit-generator.py     generátor audit reportu (+ post-deploy.sh)
AGENT_BOOTSTRAP.md     bootstrap instrukce pro agenty
AGENT_UPDATE_*.md      starší update logy (9.3.5, 10.1.0, 10.1.1)
VERSION                zastaralý soubor — nikdo ho nečte, nerozhodovat podle něj
```

Složka `governance/rules/` neexistuje.

---

## Verze

**Zdroj pravdy je `PromptVersion` v hlavičce každého promptu**, `governance/versions.json` je jen zrcadlo —
při bumpu se mění obojí. Verze se liší prompt od promptu (2026-09-23: ManagerPrompt a CatalogPrompt 12.0.2,
SimulateRealImporterPrompt 12.0.1, Skills 11.5.0).

`VERSION` (11.5.0) a `Version` v README jsou verze release, ne promptů. `MCP_VERSION` v `server.js`
(11.0.0) je verze runtime, samostatná řada.

Před tvrzením „agenti běží na verzi X" spustit `python3 scripts/check-versions.py`
(2026-09-23 hlásí 13 nesouladů hlaviček s `versions.json`).

---

## Pravidla pro práci

- Žádné secrets v repu — ani v promptech, komentářích nebo commit messages.
- Změny promptů konzultovat s uživatelem, agenti běží v produkci.
- Bump promptu = hlavička + `versions.json`; ověřit `scripts/check-versions.py`.
- Změna se projeví až po selfUpdate agenta, samotný commit nic nenasazuje.
- Distribuce promptů: MCP (`mcp.vo2info.cz/governance/`) → vo2info.cz → GitHub → Drive → DB cache.
  GitHub krok anonymně selže (private), zálohou při výpadku QNAPu je Google Drive — musí být aktuální.
- Prompty a zdrojový kód anglicky; výstupy a konverzace s uživatelem česky.
