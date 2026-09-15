# ManagerPrompt
Soubory: `governance/ManagerPrompt.txt` (4 651 ř.) + `ManagerPromptSkills.txt` (1 205 ř.)
AgentType: `Manager` · PromptVersion: **11.5.1** (ostatní prompty 11.5.0)
Popis: Největší prompt v repu. Řídí sportovní data agenty (Football, Ice Hockey, Basketball…) — sezóny, zápasy, hráče, týmy, kurzy.

## Hotovo ✅
- 19 kapitol: identita a scope, startup protokol, scheduled run, datový model sportu, události a statistiky zápasu, sezóny a soutěže, hráči a týmy, kurzy a integrita, kvalita dat, správa zdrojů, nástroje, entity governance
- Podpora obou runtime: ChatGPT Custom GPT i Claude Cloud Routine (má `ClaudeMin` i `ClaudeRecommended`)
- Definuje, že zdroj pravdy verze je `PromptVersion` v hlavičce a `versions.json` je jen zrcadlo (ř. 385)

- **11.5.1 (`5fc8c07`)** — přeneseny opravy ze 4 neslitých větví, které bump na 11.5.0 obešel: guard „MULTI-SPORT REFERENCE — NENÍ KONTAMINACE" (Ch 7), guard produktivní éry + re-seed z pre-éry + write-timeout retry (Ch 19), AIDB tool readiness a 502 retry + AIDB-outage fallback (startup)

## Chybí / Rozpracováno ⚠️
- ✅ Opraveno 2026-09-12 (`0dd6aca`): kapitola 1, řádek 1 i self-audit kontroly srovnány s hlavičkou; hlídá `scripts/check-versions.py`
- 28 řádků dál odkazuje na verze 11.0–11.4
- ✅ `GovernanceVersion` srovnána na 11.5.0 (verze release, ne promptu)
- Při 4 651 řádcích se prompt těžko vejde do menších kontextových oken; ostatní prompty u sebe mají poznámku o velikosti kontextu, Manager ne

## Návrhy na vylepšení 💡
- Bump dělat skriptem, který přepíše hlavičku, kapitolu 1 i `versions.json` naráz
- Rozdělit na jádro + sport-specifické přílohy, ať agent nenačítá 222 kB pokaždé

## Brainstorming poznámky
- Dvojice Manager + Catalog tvoří 57 % celého objemu promptů
