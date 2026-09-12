# vo2-ai-agent-governance

Kanonický repozitář governance promptů pro AI agenty VO2 (homelab vo2info.cz) + runtime MCP serverů.
**Není to Blazor projekt** — žádné `.razor`, žádné EF migrace, žádný SharedServices submodul.

## ⚠️ Repo je PUBLIC

`github.com/olsanvit/vo2-ai-agent-governance` je veřejný. Do trackovaných souborů nikdy nepatří
hesla, tokeny ani connection stringy — jen `${PROMĚNNÁ}` nebo `process.env.X`.
Skutečné hodnoty žijí v `.env` vedle `docker-compose.yml` na QNAPu a ve Vaultwardenu.
Historie úniku a postup rotace: `docs/2026-09-12-secrets-rotation.md`.

## Struktura

| Cesta | Co to je |
|---|---|
| `governance/*.txt` | 20 souborů = 10 typů agentů × (`<Typ>Prompt.txt` + `<Typ>PromptSkills.txt`). Typy: Manager, Catalog, Importer, Collector, Checker, Generator, Monitor, Analyzer, Optimizer, SimulateRealImporter |
| `governance/versions.json` | zrcadlo verzí všech 20 promptů |
| `governance/ManualSelfUpdate.txt` | šablona, kterou uživatel posílá agentovi při ruční aktualizaci |
| `server.js` | MCP server pro DB `AIData` (nasazený jako kontejner `qnap-game-mcp`, `mcp.vo2info.cz/AI`) |
| `mcp-image/mcp-mab.js`, `mcp-usm.js` | odvozené MCP servery pro další DB |
| `mcp-sportreal/` | MCP server pro `SportReal` (`mcp.vo2info.cz/SR`) |
| `audit-generator.py` + `post-deploy.sh` | generuje `audit-report.html` do wwwroot VO2DataManager |
| `releases/`, `patches/` | historické release notes a patche pro QNAP |

## Verze — zdroj pravdy

1. **`PromptVersion` v hlavičce každého promptu = zdroj pravdy** (viz `ManagerPrompt.txt:385`).
2. `governance/versions.json` je **jen zrcadlo** — při bumpu se musí aktualizovat obojí.
3. Soubor `VERSION` v rootu **nikdo nečte** a je zastaralý; neopírat o něj rozhodnutí.
4. `MCP_VERSION` v `server.js` je verze runtime, ne governance — samostatná řada.

Před tvrzením „agenti běží na verzi X" vždy porovnat hlavičky promptů s `versions.json`.

## Jazyková politika (z README)

Prompty, identifikátory, názvy v DB a zdrojový kód **anglicky**.
Výstupy scheduled běhů, reporty pro operátora a konverzace s uživatelem **česky**.

## Distribuce

GitHub je kanonický zdroj, Google Drive jen zrcadlo. Agenti stahují prompty z `mcp.vo2info.cz/governance/`
s fallbackem na GitHub — proto přepnutí repa na private rozbije fallback v `ManualSelfUpdate.txt`.

## Poznámky

- `README.md` je zastaralý: uvádí verzi 5.3.0 a soubory `CommonCatalog/CommonPrompt.txt`
  a `SportManager/SportPrompt.txt`, které v repu už nejsou.
- Změny promptů se projeví až po selfUpdate agenta — samotný commit nic nenasadí.
