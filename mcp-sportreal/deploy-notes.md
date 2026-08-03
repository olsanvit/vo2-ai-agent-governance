# mcp-sportreal — deployment notes

## URL
```
https://mcp.vo2info.cz/SR
```

## Auth token
```
Roundnet575Padel
```
Stejný jako ostatní MCP konektory.

## QNAP docker-compose.yml — přidat sekci

```yaml
  mcp-sportreal:
    build:
      context: ./mcp-sportreal
    container_name: mcp-sportreal
    restart: unless-stopped
    network_mode: host
    environment:
      DATABASE_URL: postgresql://sportreal_usr:SPORTREAL_DB_PASSWORD@192.168.60.221:5432/SportReal
      AUTH_TOKEN: Roundnet575Padel
      PORT: "3002"
      MAX_SELECT_ROWS: "500"
      SELECT_TIMEOUT_MS: "30000"
    mem_limit: 256m
    mem_reservation: 64m
    cpus: "1.0"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "--timeout=5", "http://localhost:3002/health"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
```

Nahraď `SPORTREAL_DB_PASSWORD` skutečným heslem (z Vaultwarden).

## Caddy reverse proxy — přidat do Caddyfile

Stejný pattern jako pro `/AI/` → port 3000, ale `/SR/` → port 3002:

```caddy
# SportReal MCP — read-only
handle /SR* {
    reverse_proxy localhost:3002
}
```

## Postup deploye (až QNAP pojede)

1. SSH na QNAP:
   ```
   ssh -i ~/.ssh/claude-qnap admin@192.168.60.221
   ```

2. Zkopírovat mcp-sportreal složku:
   ```
   scp -i ~/.ssh/claude-qnap -r /Users/rtvdata/Projects/vo2-ai-agent-governance/mcp-sportreal \
     admin@192.168.60.221:/share/Container/mcp-qnap/
   ```

3. Přidat sekci do docker-compose.yml (viz výše)

4. Přidat Caddy pravidlo (viz výše)

5. Build a start:
   ```
   cd /share/Container/mcp-qnap
   docker compose build mcp-sportreal
   docker compose up -d mcp-sportreal
   ```

6. Ověřit:
   ```
   curl -H "Authorization: Bearer Roundnet575Padel" \
        https://mcp.vo2info.cz/SR/health
   ```

## ChatGPT Custom GPT — přidat MCP konektor

Název: **VO2QNAPDBSR**
URL: `https://mcp.vo2info.cz/SR/mcp`
Auth: Bearer token = viz výše
