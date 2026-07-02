Systémový prompt byl aktualizován na verzi **10.1.0**. Proveď při tomto běhu následující:

1. Stáhni nové prompty z Gitea (fallback: vo2info → GitHub → Drive):
   - Gitea base: `https://gitea.vo2info.cz/olsanvit/vo2-ai-agent-governance/raw/branch/main/governance/`
   - vo2info fallback: `https://vo2info.cz/governance/`
   - GitHub fallback: `https://raw.githubusercontent.com/olsanvit/vo2-ai-agent-governance/main/governance/`
   - Stáhni: `{AgentType}Prompt.txt` + `{AgentType}PromptSkills.txt`

2. Ověř že načtená verze = 10.1.0 (řádek PromptVersion v souboru).

3. Zaznamenej do `AgentVersionRegistry`:
   - `PromptVersion = 10.1.0`
   - `SkillsVersion = 10.1.0`
   - `MCPVersion = 10.1.0`
   - `LastStartupAt = NOW()`

4. Pošli ntfy notifikaci na `agent-status`:
   - Title: `[AgentName] aktualizován na 10.1.0`
   - Zpráva: `Prompt, Skills a MCP verze 10.1.0 načteny.`

---

## Co je nového v 10.1.0

### MCP servery
- `create_rls_policy`: přidána SQL injection validace (forbidden keywords + max 500 znaků)
- Sheets API: GOOGLE_SERVICE_ACCOUNT_JSON nyní funguje přes service account soubor
- mcp-usm: MIME type validace pro upload obrázků
- mcp-usm: opraveno dvojité wrappování MCP response
- mcp-mab: email transporter cachován (výkon)
- mcp-mab: circuit breaker pro `run_select_sql`

### Databáze
- `idle_in_transaction_session_timeout` zvýšen na 30 minut pro role `AgentAI` a `roundnet`
- Nové tabulky: `AgentVersionRegistry`, `ManualReviewQueue`, `QuarantineQueue`, `DiscoveryQueue`

### Governance prompty
- Všechny verze synchronizovány na 10.1.0 (Agent header, Chapter header, BLOK 2 self-audit)
- CatalogPrompt: opraven folder ID reference, odstraněna zastaralá poznámka o Sheets
- ManagerPrompt: přidána sekce `ANTI-HALLUCINATION PRAVIDLA`
- Checker/Collector/Generator/Importer: changelog 10.1.0, tab count opraven na 7
- ImporterPrompt: přidán krok `CALENDAR ID RESOLUTION`
- ntfy topic `agent-status`: přidán do všech MCP schema a ACL

### ntfy
- Topic `agent-status` přidán do ACL uživatele `vitek` (read-only)
- Všichni 4 MCP servery: `agent-status` v z.enum pro `send_notification`

---

## Self-test po aktualizaci

Po načtení nového promptu proveď:

1. **DB ping** — `db_ping` nebo základní SELECT — ověř spojení
2. **AgentVersionRegistry** — zapiš novou verzi (upsert přes `upsert_record`)
3. **ntfy test** — `send_notification(topic="agent-status", ...)` — ověř že topic funguje
4. **Sheets API** (jen Catalog a Manager agenti) — zkus `sheets_get_values` na svůj master spreadsheet — ověř přístup
5. **Self-update check** — `PromptVersion v DB` == `10.1.0` ?

Pokud vše proběhlo OK, zapiš do svého master spreadsheet tab `notes`:
```
[10.1.0 update: OK — datum]
```
