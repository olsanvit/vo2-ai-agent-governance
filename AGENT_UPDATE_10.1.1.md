Systémový prompt byl aktualizován na verzi **10.1.1**. Proveď při tomto běhu následující:

1. Stáhni nové prompty — **nový primární zdroj mcp.vo2info.cz**:
   - **MCP (primární):** `https://mcp.vo2info.cz/governance/` ← NOVÉ, bez bot-blokace
   - Gitea fallback: `https://gitea.vo2info.cz/olsanvit/vo2-ai-agent-governance/raw/branch/main/governance/`
   - vo2info fallback: `https://vo2info.cz/governance/`
   - GitHub fallback: `https://raw.githubusercontent.com/olsanvit/vo2-ai-agent-governance/main/governance/`
   - Stáhni: `{AgentType}Prompt.txt` + `{AgentType}PromptSkills.txt`

2. Ověř že načtená verze = 10.1.0 (PromptVersion v souboru — prompt verze se nemění, jen governance).

3. Zapiš do `AgentVersionRegistry`:
   - `GovernanceVersion = 10.1.1`
   - `LastStartupAt = NOW()`

4. Pošli ntfy notifikaci na `agent-maintenance`:
   - Title: `🔧 {AgentName} — governance 10.1.1`
   - Zpráva: `MCP governance endpoint aktivní | DB přes pgbouncer | Sheets SA opraveno`

---

## Co je nového v 10.1.1

### Infrastruktura (opraveno 2026-07-04)

**1. DB 502/503 — OPRAVENO**
- MCP server byl připojen přímo na pg16:5432 (pool max 10)
- Nově: pgbouncer port 5433 (pool 300 spojení), PG_POOL_MAX=5
- Dopad: eliminace DB timeout chyb při souběžných bězích agentů

**2. Sheets 403 — OPRAVENO**
- Google service account JSON byl chybějící v MCP kontejneru
- Nově: namountován jako `/app/service-account.json`, env `GOOGLE_SERVICE_ACCOUNT_JSON_FILE`
- Dopad: Sheets API zápisy fungují od tohoto běhu

**3. Governance URL — NOVÝ ENDPOINT**
- `https://mcp.vo2info.cz/governance/` je nyní primární zdroj promptů
- Stejný server jako MCP (trustovaná doména, bez Cloudflare bot-blokace)
- Všechny prompt soubory aktualizovány — mcp.vo2info.cz je priorita #0 nebo #2a

### Prompt soubory (verze 10.1.0, governance 10.1.1)
- CatalogPrompt.txt — přidán MCP jako priorita 0 v governance chain
- ManagerPrompt.txt — přidán MCP jako priorita 0 v governance chain
- CheckerPrompt.txt — přidán MCP jako krok 2a (před Gitea)
- CollectorPrompt.txt — přidán MCP jako krok 2a
- GeneratorPrompt.txt — přidán MCP jako krok 2a
- ImporterPrompt.txt — přidán MCP jako krok 2a

---

## Self-test po aktualizaci

1. **MCP governance test** — WebFetch `https://mcp.vo2info.cz/governance/{AgentType}Prompt.txt` — ověř HTTP 200
2. **DB ping** — ověř spojení přes pgbouncer (latence by měla být nižší)
3. **Sheets API test** — zkus `sheets_get_values` na svůj master spreadsheet
4. **AgentVersionRegistry** — zapiš `GovernanceVersion = 10.1.1`
5. **ntfy** — pošli na `agent-maintenance` potvrzení

---

## Kompatibilita

- Zpětně kompatibilní s 10.1.0 — žádné breaking changes
- Agenti na 10.0.x: doporučeno přejít na 10.1.0 prompty přes mcp.vo2info.cz
