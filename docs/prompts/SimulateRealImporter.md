# SimulateRealImporterPrompt
Soubory: `governance/SimulateRealImporterPrompt.txt` (396 ř.) + `SimulateRealImporterPromptSkills.txt` (122 ř.)
AgentType: `Importer` · PromptVersion: 11.5.0
Popis: Specializovaný importer pro DB `SportReal` — discovery, dedup, import po sportech.

## Hotovo ✅
- 8 kapitol: quick reference, startup, discovery protokol, dedup check, import per sport, referenční tabulky v SportReal, error handling, ntfy formát
- Jako jediný prompt má kapitoly psané česky

## Chybí / Rozpracováno ⚠️
- **Kolize `AgentType: Importer`** s obecným ImporterPromptem
- Referenční seznam tabulek v kapitole 6 je statický — při změně schématu `SportReal` zastará
- Pozor na [[project_qnap_sr_mcp_wrong_db]]: MCP `/SR` mířilo na prázdnou DB `sportReal` místo `SportReal`, takže „0 řádků" nemuselo znamenat prázdná data

## Návrhy na vylepšení 💡
- Tabulky číst z `list_tables` místo statického seznamu

## Brainstorming poznámky
- Jediný prompt vázaný na konkrétní aplikaci, ne na obecnou roli
