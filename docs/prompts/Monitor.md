# MonitorPrompt
Soubory: `governance/MonitorPrompt.txt` (206 ř.) + `MonitorPromptSkills.txt` (94 ř.)
AgentType: `Monitor` · PromptVersion: 11.5.0 · přidán v `d64140e`
Popis: Monitoring agentů, projektů a infrastruktury — čte ntfy, Sheets, DB a CI/CD, eskaluje nálezy.

## Hotovo ✅
- Kompletní, jen kompaktní: 4 kapitoly, 8krokový startup, 12krokový monitoring run
- SILENT MODE — tool výstupy se nevypisují do chatu, detail jde do ntfy a run reportu
- Priorizace nálezů (CRITICAL/HIGH/MEDIUM/LOW), deduplikace, `MaxAlertsPerRun`
- Auto-fix jen pro bezpečné akce; cokoliv přes SSH → „vyžaduje manuální akci"
- Zákaz DELETE/DROP/TRUNCATE a zákaz vymýšlet si chyby
- Konfigurace z Drive `{AgentName}_config.txt`

## Chybí / Rozpracováno ⚠️
- Verze uvnitř i v hlavičce souhlasí (11.5.0) — na rozdíl od starších promptů
- Nemá poznámku o velikosti kontextu, kterou ostatní mají
- `MonitorScope: infrastructure` počítá s daty, ke kterým se bez SSH nedostane

## Návrhy na vylepšení 💡
- Zapracovat poučky z lokálních watchdogů: výpadek ověřovat z QNAPu, ne z Macu ([[project_qnap_io_starvation_false_mcp_outage]]), a HTTP 200 nebrat jako důkaz zdraví ([[project_qnap_mcp_healthcheck_misconfigured]])

## Brainstorming poznámky
- Překrývá se se scheduled tasky na Macu (`qnap-mcp-watchdog`, `url-monitor`) — vyjasnit, kdo co hlídá, ať nechodí dvojité alerty
