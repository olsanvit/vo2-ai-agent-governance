# CatalogPrompt
Soubory: `governance/CatalogPrompt.txt` (5 521 ř.) + `CatalogPromptSkills.txt` (1 206 ř.)
AgentType: `Catalog` · PromptVersion: 11.5.0
Popis: Nejdelší prompt. Katalogizační agent — správa entit, deduplikace, scoring, kvalita dat a jejich původ.

## Hotovo ✅
- 13 kapitol: identita a kanonický zdroj, startup, scheduled run, datový model a schéma, kvalita dat, správa zdrojů, nástroje, entity governance, reporting, compliance, release a verzování
- Fuzzy matching a token similarity s prahem 80 % → `ManualReviewQueue`
- Cost dimensions (tokeny, API kvóty, zátěž DB, cache)

## Chybí / Rozpracováno ⚠️
- **Kapitola 1 hlásí 11.2.1, hlavička 11.5.0**; 19 řádků odkazuje na verze 11.0–11.4
- Vnitřní rozpor verzí: ř. 3253 `GovernanceVersion: 10.1.0` a `ImageGovernanceVersion: 10.1.0`, ale ř. 4387–4392 `11.0.0` — ani jedno není 11.5.0
- Při 247 kB je to největší jednotlivý soubor v repu

## Návrhy na vylepšení 💡
- Sjednotit `GovernanceVersion` / `ImageGovernanceVersion` / `ProviderGovernanceVersion` na jedno místo
- Vyčlenit sdílené kapitoly (startup, notifikace, self-audit) do společného includu s ostatními prompty

## Brainstorming poznámky
- Sdílí s Managerem skoro totožné kapitoly o kvalitě dat a správě zdrojů — kandidát na společný základ
