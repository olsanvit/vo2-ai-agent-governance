# Nasazení oprav MCP serverů

> Opravy jsou v repu od 2026-09-15, ale **v provozu nejsou** — commit nic nenasazuje.
> Runbook sepsán bez přístupu na QNAP; kroky označené „ověřit" je nutné potvrdit na místě.

## Co se nasazuje

| Soubor | Oprava | Kontejner |
|---|---|---|
| `server.js` | upsert už nespouští katalogové DDL při každém volání + `PG_STATEMENT_TIMEOUT` / `PG_IDLE_TX_TIMEOUT` | `qnap-game-mcp` |
| `mcp-image/mcp-usm.js` | `db_ping` hlásí skutečnou DB (`current_database()`), `schemaOk`, `missingTables` | `mcp-usm` |
| `mcp-image/mcp-mab.js` | jen bump `MCP_VERSION` na 11.2.0 | `mcp-mab` |

**Proč na tom záleží:** bez opravy `server.js` se upserty řadí za zámky katalogu — doložený
případ 45 s na tabulce s 273 řádky, timeout a vyčerpaný pool. Souvisí s incidenty
„transaction leak" a „upsert self-deadlock".

## Postup

1. **Ověřit, odkud se který kontejner sestavuje.** `qnap-game-mcp` staví z `/share/Container/mcp-qnap`
   (`build: .`). U `mcp-usm` a `mcp-mab` to ověřit:
   ```bash
   DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
   for c in qnap-game-mcp mcp-usm mcp-mab; do
     echo "$c: $($DOCKER inspect $c --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')"
   done
   ```
2. **Zkopírovat soubory** z repa do build adresářů (z Macu):
   ```bash
   scp server.js admin@192.168.60.221:/share/Container/mcp-qnap/server.js
   # mcp-usm.js a mcp-mab.js do adresářů zjištěných v kroku 1
   ```
3. **Postupně, ne najednou** — nejdřív `mcp-usm` (nejmenší dopad), ověřit, pak `qnap-game-mcp`:
   ```bash
   cd <build_dir> && $DOCKER compose up -d --build mcp-usm
   ```
4. **Ověřit zdraví tělem odpovědi, ne HTTP kódem** (router vrací 200 i na neexistující endpoint):
   ```bash
   curl -s http://localhost:3001/health   # musí obsahovat protocolVersion i serverInfo
   ```
   U `mcp-usm` navíc zkontrolovat, že `db_ping` vrací skutečný název DB a `schemaOk`.
5. **Sledovat zámky** po nasazení `server.js` — cílem je, aby upserty přestaly čekat:
   ```sql
   SELECT pid, state, wait_event_type, wait_event, left(query,60)
   FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;
   ```

## Rollback

Kontejnery běží z build adresáře, ne z registru — zpět se vrací obnovením předchozí verze
souboru (`server.js.bak`, proto před kopií udělat zálohu) a `compose up -d --build`.
Ověřit, že `MCP_VERSION` v `db_ping` odpovídá očekávané verzi.

## Pozor

- Nasazovat, až bude QNAP stabilní — 14. i 15. 9. byl celý host nedostupný.
- `mcp-router` píše `AUTH_TOKEN` do logů; po rotaci logy smazat (viz runbook rotace).
