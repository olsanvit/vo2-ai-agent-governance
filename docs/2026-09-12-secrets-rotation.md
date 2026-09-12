# Rotace credentials — 2026-09-12

> Repo `vo2-ai-agent-governance` je **public** a mělo v trackovaných souborech živé hodnoty.
> Soubory jsou opravené, ale **historie zůstává veřejně čitelná**, dokud se neudělá krok 3.

## Co uniklo

| Soubor | Hodnota | Commit |
|---|---|---|
| `patches/docker-compose-hardening.yml` | heslo `AgentAI` k `AIData` (pg16, port 5433), `AUTH_TOKEN` MCP serveru, `GITEA_TOKEN` | `b60bcc8` |
| `mcp-sportreal/deploy-notes.md` | heslo `sportreal_usr`, `AUTH_TOKEN` (i v příkladu `curl`) | `ddbb7f0` |
| `releases/vo2-governance-5.4.0.patch` | fallback `AUTH_TOKEN` v `server.js` | `c8c2eb1` |

Ověřeno `curl`em 2026-09-12: `raw.githubusercontent.com` vracel na oba první soubory HTTP 200 bez přihlášení.

## Krok 1 — rotace (nutné první, jinak nemá zbytek smysl)

Pořadí je zvolené tak, aby výpadek byl co nejkratší: nejdřív nová hodnota do `.env`, pak restart.

1. **pg16 `AgentAI`** — nové heslo, pak `.env` u `mcp-qnap` a `docker compose up -d`.
   Pozor: na `AgentAI` jede většina sportovních agentů, po rotaci je nutné ověřit `db_ping`.
2. **pg16 `sportreal_usr`** — totéž pro kontejner `mcp-sportreal`.
3. **`AUTH_TOKEN` MCP serverů** — mění se současně na serveru i ve všech MCP konektorech
   (`qnap-ai`, `qnap-mab`, `qnap-te`, `qnap-usm`, `qnap-sr` v `~/.claude.json`).
   Dokud se nepřenastaví obě strany, konektory vrací 401.
4. **`GITEA_TOKEN`** — regenerovat v Gitei. Podle [[project_qnap_gitea_tunnel_502]] nejdřív ověřit
   vnitřní port, ať se token neregeneruje kvůli cizí chybě.

Nové hodnoty rovnou do Vaultwarden (`http://localhost:8222` přes SSH tunel).

## Krok 2 — soubory (hotovo 2026-09-12)

Hodnoty nahrazeny proměnnými: `${AGENT_DB_PASSWORD}`, `${MCP_AUTH_TOKEN}`, `${GITEA_TOKEN}`,
`${SPORTREAL_DB_PASSWORD}`, `${MCP_SPORTREAL_AUTH_TOKEN}`. Docker compose je dosadí z `.env`
vedle `docker-compose.yml` na QNAPu. `.env` do repa nikdy nepatří.

## Krok 3 — historie

Smazání z HEAD nestačí, staré commity jsou dál veřejné. Dvě cesty:

- **Repo na private** — nejrychlejší, historii neřeší, ale odřízne veřejný přístup.
  Pozor: `ManualSelfUpdate.txt` odkazuje na GitHub jako fallback pro stažení promptů —
  po přepnutí na private ten fallback přestane fungovat.
- **`git filter-repo`** — přepíše historii, nutný `push --force` a přegenerování všech klonů.

Bez ohledu na volbu platí: **credentials, které jednou byly v public repu, se musí rotovat.**

---

## Ověřená mapa konzumentů (2026-09-12)

Zjištěno z `docker inspect` na QNAPu — **jen proměnné prostředí**, konfigurační soubory
uvnitř kontejnerů tenhle sken nevidí.

| Uživatel | Kontejnery |
|---|---|
| `AgentAI` | `qnap-game-mcp`, `vin-importer` |
| `roundnet` | `mcp-usm`, `qnap-te-mcp`, `mcp-sportreal` |
| `mercs_beasts_usr` | `mcp-mab` + aplikace MercenariesAndBeasts (přes `appsettings.Production.json`, ne env) |

Stejný `AUTH_TOKEN` sdílí 6 kontejnerů: `qnap-game-mcp`, `mcp-mab`, `mcp-usm`,
`qnap-te-mcp`, `mcp-sportreal`, `mcp-oauth`.

**`.env` na QNAPu neexistuje** — hodnoty jsou inline v `/share/Container/mcp-qnap/docker-compose.yml`.

**`mcp-router` loguje token** do `*-json.log` (přes 20 MB v čitelné podobě). Po rotaci logy
smazat a opravit logování, jinak se tam nový token vysype znovu.

## Postup pro `AgentAI` (nejmenší rozsah — 2 kontejnery)

```bash
DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
NEW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)   # heslo si ulož do Vaultwarden

# 1) nové heslo v pg16
$DOCKER exec pg16 psql -U postgres -c "ALTER USER \"AgentAI\" WITH PASSWORD '$NEW';"

# 2) .env vedle compose (nově — dosud tam nebyl)
cd /share/Container/mcp-qnap
grep -q AGENT_DB_PASSWORD .env 2>/dev/null || echo "AGENT_DB_PASSWORD=$NEW" >> .env
chmod 600 .env

# 3) v docker-compose.yml nahradit heslo za ${AGENT_DB_PASSWORD}
#    (compose dosadí z .env ve stejném adresáři)

# 4) restart obou konzumentů
$DOCKER compose up -d qnap-game-mcp
# vin-importer má vlastní compose — najít přes: $DOCKER inspect vin-importer | grep compose

# 5) ověření — musí vrátit tělo s protocolVersion i serverInfo, ne jen HTTP 200
curl -s -X POST http://localhost:3000/health | head -c 200
```

Pořadí je důležité: heslo v DB se mění jako první, protože od té chvíle kontejner stejně
nefunguje — čím kratší mezera do restartu, tím míň chyb v logu agentů.

## Co po rotaci NESMÍ zůstat

- staré heslo v `docker-compose.yml` (nahradit `${VAR}`)
- token v logách `mcp-router`
- staré hodnoty ve Vaultwarden (přepsat, ne přidat druhý záznam)
