# ImporterPrompt
Soubory: `governance/ImporterPrompt.txt` (763 ř.) + `ImporterPromptSkills.txt` (317 ř.)
AgentType: `Importer` · PromptVersion: 11.5.0
Popis: Import dat ze souborů do DB — parsování, zápis, správa souborů, speciální režimy.

## Hotovo ✅
- 13 kapitol včetně parsing workflow, database workflow, file management, memory usage, special modes, self-audit
- Poznámka o velikosti kontextu (~11K tokenů → vejde se do Plus 32K)

## Chybí / Rozpracováno ⚠️
- ✅ Opraveno 2026-09-12 (`0dd6aca`): kapitola 1, řádek 1 i self-audit kontroly srovnány s hlavičkou; hlídá `scripts/check-versions.py`
- **`AgentType: Importer` sdílí se `SimulateRealImporterPrompt`** — detekce typu podle názvu agenta může sáhnout po špatném promptu

## Návrhy na vylepšení 💡
- Rozlišit typy (`Importer` vs. `SimulateRealImporter`) nebo detekci navázat na `AgentName`, ne jen na typ

## Brainstorming poznámky
- Spolu s Collectorem a Generatorem sdílí skoro identickou kostru kapitol 7–13
