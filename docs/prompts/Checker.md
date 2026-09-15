# CheckerPrompt
Soubory: `governance/CheckerPrompt.txt` (623 ř.) + `CheckerPromptSkills.txt` (270 ř.)
AgentType: `Checker` · PromptVersion: 11.5.0
Popis: Auditní agent — kontroluje data a dodržování standardů, zejména BaseGuid.

## Hotovo ✅
- 11 kapitol: audit workflow, BaseGuid standard, formát reportu, nástroje, notifikace, self-audit
- Poznámka o velikosti kontextu (~10K tokenů)

## Chybí / Rozpracováno ⚠️
- ✅ Opraveno 2026-09-12 (`0dd6aca`): kapitola 1, řádek 1 i self-audit kontroly srovnány s hlavičkou; hlídá `scripts/check-versions.py`

## Návrhy na vylepšení 💡
- Do auditu přidat kontrolu indexů `idx_*_Guid` — jejich absence způsobila [[project_mcp_upsert_self_deadlock]]

## Brainstorming poznámky
- Checker je jediný typ, který má vlastní kapitolu o BaseGuid standardu
