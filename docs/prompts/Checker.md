# CheckerPrompt
Soubory: `governance/CheckerPrompt.txt` (623 ř.) + `CheckerPromptSkills.txt` (270 ř.)
AgentType: `Checker` · PromptVersion: 11.5.0
Popis: Auditní agent — kontroluje data a dodržování standardů, zejména BaseGuid.

## Hotovo ✅
- 11 kapitol: audit workflow, BaseGuid standard, formát reportu, nástroje, notifikace, self-audit
- Poznámka o velikosti kontextu (~10K tokenů)

## Chybí / Rozpracováno ⚠️
- Kapitola 1 hlásí 11.2.1 proti hlavičce 11.5.0; 6 řádků odkazuje na starší verze

## Návrhy na vylepšení 💡
- Do auditu přidat kontrolu indexů `idx_*_Guid` — jejich absence způsobila [[project_mcp_upsert_self_deadlock]]

## Brainstorming poznámky
- Checker je jediný typ, který má vlastní kapitolu o BaseGuid standardu
