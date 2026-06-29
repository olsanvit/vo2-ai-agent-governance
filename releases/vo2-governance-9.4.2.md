# vo2-governance 9.4.2

Released: 2026-06-29

## Summary

Oprava ntfy notifikací (síťová izolace) a upgrade formátu `send_notification` na JSON+markdown v mcp-mab.js a mcp-usm.js. Přidán topic `agent-digest`, podpora `markdown` a `click` parametrů.

## Changes

### 1. mcp-mab.js a mcp-usm.js: v9.4.1 → v9.4.2

**`send_notification` — JSON formát s markdown podporou:**
- Změna z `text/plain` na `Content-Type: application/json`
- Nové parametry: `markdown` (bool, default true), `click` (URL pro deep-link)
- Nový topic: `agent-digest` (přidán vedle agent-runs, agent-errors, agent-alerts, agent-maintenance)
- mcp-mab: qnap-health a qnap-alerts topicy přidány (jen MAB)

### 2. ntfy infrastruktura — oprava síťové izolace

**Problém:** ntfy byl na Docker síti `appnet` (172.29.12.3), MCP kontejnery na `host` síti. Port forwarding nefungoval na QNAP (iptables omezení) → notifikace selhávaly.

**Řešení:**
- ntfy přepnut na `network_mode: host`, port 8225
- `server.yml`: `listen-http: 0.0.0.0:8225`
- cloudflared config: `ntfy.vo2info.cz → http://localhost:8225` (bylo `http://172.29.12.3:80`)
- Sysctls odstraněny (nekompatibilní s host network mode)

### 3. Prompty: CatalogPrompt.txt a ManagerPrompt.txt

- Sekce `send_notification` FORMÁT VOLÁNÍ aktualizována: přidán `agent-digest` topic a `markdown = true`

## Files Modified

- `mcp-image/mcp-mab.js` (v9.4.2)
- `mcp-image/mcp-usm.js` (v9.4.2)
- `governance/CatalogPrompt.txt`
- `governance/ManagerPrompt.txt`
- `VERSION` (9.3.0 → 9.4.2)

## Infrastructure Changes (QNAP only, not in git)

- `/share/Public/ntfy/server.yml`: listen-http → 0.0.0.0:8225
- `/share/Public/ntfy/docker-compose.yml`: network_mode: host, removed ports mapping, removed sysctls
- `/share/Container/cloudflared/config.yml`: ntfy.vo2info.cz → http://localhost:8225

## Backward Compatibility

✅ send_notification: zpětně kompatibilní — nové parametry jsou optional  
✅ ntfy URL v MCP kontejnerech: `NTFY_URL=http://127.0.0.1:8225` (přímé, bez cloudflared)  
✅ ntfy.vo2info.cz: stále funguje pro ruční přístupy z prohlížeče  
