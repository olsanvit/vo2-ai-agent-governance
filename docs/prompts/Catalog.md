# CatalogPrompt
Soubory: `governance/CatalogPrompt.txt` (5 521 ř.) + `CatalogPromptSkills.txt` (1 206 ř.)
AgentType: `Catalog` · PromptVersion: 11.5.0
Popis: Nejdelší prompt. Katalogizační agent — správa entit, deduplikace, scoring, kvalita dat a jejich původ.

## Hotovo ✅
- 13 kapitol: identita a kanonický zdroj, startup, scheduled run, datový model a schéma, kvalita dat, správa zdrojů, nástroje, entity governance, reporting, compliance, release a verzování
- Fuzzy matching a token similarity s prahem 80 % → `ManualReviewQueue`
- Cost dimensions (tokeny, API kvóty, zátěž DB, cache)

## Chybí / Rozpracováno ⚠️
- ✅ Opraveno 2026-09-12 (`0dd6aca`): kapitola 1, řádek 1 i self-audit kontroly srovnány s hlavičkou; hlídá `scripts/check-versions.py`
- ✅ Opraveno 2026-09-12: `GovernanceVersion` sjednocena na 11.5.0; starší registr Schema/RuntimeSafety/Image srovnán s novějším (11.0.0 — jiná osa)
- Při 247 kB je to největší jednotlivý soubor v repu

## Návrhy na vylepšení 💡
- Sjednotit `GovernanceVersion` / `ImageGovernanceVersion` / `ProviderGovernanceVersion` na jedno místo
- Vyčlenit sdílené kapitoly (startup, notifikace, self-audit) do společného includu s ostatními prompty

## Brainstorming poznámky
- Sdílí s Managerem skoro totožné kapitoly o kvalitě dat a správě zdrojů — kandidát na společný základ
