# CollectorPrompt
Soubory: `governance/CollectorPrompt.txt` (703 ř.) + `CollectorPromptSkills.txt` (449 ř.)
AgentType: `Collector` · PromptVersion: 11.5.0
Popis: Sběr dat z externích zdrojů — collection workflow, validace, zápis.

## Hotovo ✅
- 11 kapitol: identita, startup, collection workflow, datový model, kvalita a validace, nástroje, notifikace, self-audit, run report, governance extensions
- Poznámka o velikosti kontextu (~11K tokenů)

## Chybí / Rozpracováno ⚠️
- ✅ Opraveno 2026-09-12 (`0dd6aca`): kapitola 1, řádek 1 i self-audit kontroly srovnány s hlavičkou; hlídá `scripts/check-versions.py`
- Skills soubor je na svou velikost promptu neobvykle velký (449 ř.) — stojí za kontrolu, jestli se nepřekrývá s Importerem

## Návrhy na vylepšení 💡
- Sjednotit sdílené kapitoly s Importerem a Generatorem

## Brainstorming poznámky
- Podle [[project_qnap_sheets_api_rate_limit]] naráží sběrové agenty na kvóty Sheets API — prompt by měl mít explicitní backoff
