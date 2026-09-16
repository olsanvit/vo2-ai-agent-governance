# Rotace credentials — 2026-09-12

> Repo `vo2-ai-agent-governance` je **public** a mělo v trackovaných souborech živé hodnoty.
> Soubory jsou opravené, ale **historie zůstává veřejně čitelná**, dokud se neudělá krok 3.

## Co uniklo

| Soubor | Hodnota | Commit |
|---|---|---|
| `patches/docker-compose-hardening.yml` | heslo `AgentAI` k `AIData` (pg16, port 5433), `AUTH_TOKEN` MCP serveru, `GITEA_TOKEN` | `b60bcc8` |
| `mcp-sportreal/deploy-notes.md` | `AUTH_TOKEN` (i v příkladu `curl`); heslo `sportreal_usr` tam **nebylo** — jen placeholder `SPORTREAL_DB_PASSWORD` | `ddbb7f0` |
| `releases/vo2-governance-5.4.0.patch` | fallback `AUTH_TOKEN` v `server.js` | `c8c2eb1` |

Ověřeno `curl`em 2026-09-12: `raw.githubusercontent.com` vracel na oba první soubory HTTP 200 bez přihlášení.

## Krok 1 — rotace (nutné první, jinak nemá zbytek smysl)

Pořadí je zvolené tak, aby výpadek byl co nejkratší: nejdřív nová hodnota do `.env`, pak restart.

1. **pg16 `AgentAI`** — nové heslo, pak `.env` u `mcp-qnap` a `docker compose up -d`.
   Pozor: na `AgentAI` jede většina sportovních agentů, po rotaci je nutné ověřit `db_ping`.
2. ~~pg16 `sportreal_usr`~~ — **nerotovat kvůli úniku**: ověřeno 2026-09-14, že heslo v historii nikdy nebylo (jen název proměnné). `mcp-sportreal` navíc ve skutečnosti běží pod `roundnet`.
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
| `roundnet` ⚠️ **superuser** | `mcp-usm`, `qnap-te-mcp`, `mcp-sportreal` |
| `mercs_beasts_usr` | `mcp-mab` + aplikace MercenariesAndBeasts (přes `appsettings.Production.json`, ne env) |

**`roundnet` je superuser pg16** a podle pravidla smí sloužit jen migracím. Tři MCP servery
ho přesto používají. Rotace jeho hesla shodí všechny tři **a** migrace. Správná oprava:
vytvořit každému serveru vlastní roli s právy jen na jeho DB a teprve pak `roundnet` rotovat.

Stejný `AUTH_TOKEN` sdílí 6 kontejnerů: `qnap-game-mcp`, `mcp-mab`, `mcp-usm`,
`qnap-te-mcp`, `mcp-sportreal`, `mcp-oauth`.

**`.env` na QNAPu neexistuje** — hodnoty jsou inline v `/share/Container/mcp-qnap/docker-compose.yml`.

**`mcp-router` loguje token** do `*-json.log` (přes 20 MB v čitelné podobě). Po rotaci logy
smazat a opravit logování, jinak se tam nový token vysype znovu.

## Stav rotace k 2026-09-15 22:10

| Hodnota | Stav |
|---|---|
| Heslo `AgentAI` | ✅ rotováno (21:49, `.env` → `AGENT_DB_PASSWORD`); `qnap-game-mcp` přes compose, `vin-importer` znovu vytvořen s DSN v `secrets/vin-importer.env` |
| MCP `AUTH_TOKEN` | ✅ rotován (`.env` → `MCP_AUTH_TOKEN`); compose služby `mcp`, `mcp-sportreal` + znovu vytvořené `mcp-mab`, `mcp-usm`, `qnap-te-mcp`, `mcp-oauth` (`scripts/finish-token-rotation-qnap.sh`, env v `secrets/<kontejner>.env`, 600) |
| Heslo admina ntfy | ✅ 2026-09-16: uniklá hodnota už heslem admina **není** (ntfy ji odmítá, 401; kdy se heslo změnilo, nelze zjistit) → 14 kontejnerů s `NTFY_USER=admin` a starou hodnotou posílalo notifikace neúspěšně. Nově uživatel `publisher` (write-only na `*`, heslo + token v `secrets/ntfy-publisher.env`); všech 14 kontejnerů znovu vytvořeno přes Docker API se stejnou konfigurací (`scripts/qnap/docker-clone-with-env.js`), soubory na QNAPu upraveny (`scripts/qnap/ntfy-files-fix.sh`, zálohy `secrets/files-backup-*`) |
| Hlavní heslo Vaultwardenu | ❌ **= uniklá hodnota** (`vw-import.sh`/`.py` v `mcp-qnap/`, práva 600) — změnit v rozhraní Vaultwardenu (uživatel), pak smazat `vw-import.*` (obsahují i další přístupy) |
| Heslo uptime-kuma | ❌ **= uniklá hodnota** (`uptime-kuma/*.py`, práva 600) — změnit v rozhraní (uživatel) |
| `diun` token | ✅ nahrazen tokenem `publisher` (`diun` stojí) |
| Heslo `n8nuser` (pg16) | ✅ 2026-09-16 13:15: bylo = starý token (MD5, dostupné z LAN) → nové SCRAM heslo v `secrets/n8nuser.pw`; `n8n` stojí, při spuštění mu nastavit nové heslo |
| `mt2-postgres` (`POSTGRES_PASSWORD`) | ⚠️ = starý token; kontejner stojí, bez publikovaného portu — rotovat při dalším spuštění |
| `GITEA_TOKEN` | ✅ 2026-09-16 13:06 zneplatněn (`revoke-gitea-token-qnap.sh`): token `agents-token-…` uživatele `olsanvit` (admin, scope all) smazán z DB, Gitea restartována, starý token → 401; z compose odstraněn (kód ho nepoužívá). Nový token nevytvořen — není potřeba |
| Heslo `roundnet` | ✅ 2026-09-16 12:45 (`rotate-roundnet-qnap.sh`): nové heslo v DB a v `appsettings.Production.json` BlazorSimulateReal, BlazorSportManager, BlazorSimulateBackup; `simulatereal` a `unisportmanager` restartovány bez chyb. Nové heslo v `secrets/roundnet.pw` → Vaultwarden, pak smazat |
| `mcp-sportreal` → `mcp_sr_usr` | ✅ 2026-09-16: role jen pro čtení na `sportReal` (`default_transaction_read_only`), heslo v `.env` → `MCP_SR_DB_PASSWORD`; compose už `roundnet` neobsahuje |
| `mcp-usm` → `mcp_usm_usr` | ✅ 2026-09-16 (člen `sportmanager_usr`); server dál nefunkční kvůli schématu, viz níže |
| `qnap-te-mcp` → `mcp_te_usr` | ✅ 2026-09-16: 17 tabulek + funkce `set_updated_at` v `TopEleven` převedeny na `topeleven_usr` (seznam v `secrets/te-owned-by-roundnet-20260916-124204.txt`), „DB initialized OK" |
| `mcp-router` | ✅ 2026-09-16 13:03 (`fix-mcp-router-token-qnap.sh`): nginx `map` měl natvrdo STARÝ token → od rotace 09-15 22:08 veřejný endpoint odmítal nový token (všechny konektory 401). Opraveno, `log_format` už neobsahuje `Authorization`, staré logy smazány, `nginx.conf*` práva 600 |

`/share/Container/mcp-qnap/secrets/` drží env souborů `docker run` kontejnerů — při dalším vytvoření
kontejneru použít `--env-file` odtud, ne inline `-e`.

### Připravené kroky ke spuštění (2026-09-16, v tomto pořadí)

Každý skript: `scp` do `/share/Container/mcp-qnap/secrets/`, spustit `sh <soubor>` na QNAPu, pak smazat.
Nespouštět přes `ssh … 'sh -s' < skript` — `docker exec -i` uvnitř by spolklo zbytek skriptu.

1. `scripts/mcp-sportreal-db-fix-qnap.sh` — `mcp-sportreal` na `SportReal` (data), ověří neprázdné `sr_list_sports`.
2. `scripts/least-privilege-usm-qnap.sh` — `mcp-usm` na `mcp_usm_usr` (člen `sportmanager_usr`).
3. `scripts/least-privilege-te-qnap.sh` — převod 17 objektů v `TopEleven` na `topeleven_usr`, `qnap-te-mcp` na `mcp_te_usr`.
4. `scripts/rotate-roundnet-qnap.sh` — až po 2 a 3 (sám to kontroluje): nové heslo `roundnet`, úprava
   `appsettings.Production.json` u BlazorSimulateReal, BlazorSportManager, BlazorSimulateBackup (666 → 644),
   restart `simulatereal` a `unisportmanager`, kontrola chyb autentizace, jinak rollback.

`mcp-usm` zůstane i po kroku 2 nefunkční: nástroje zapisují `LogoUrl`/`PhotoUrl`, které v živém schématu
`UniSportManager` nejsou — patří do EF migrace aplikace UniSportManager, pak přepsat `mcp-usm.js`
(repo i QNAP kopie se navíc liší). Obě DB jsou momentálně bez týmů a hráčů.

### Nalezené chyby konfigurace (2026-09-16, neopraveno)

- **`mcp-usm` je nefunkční:** míří na DB `UniSportManager` (živá, tabulky `Teams`/`Players`), ale kód
  (`mcp-image/mcp-usm.js`) pracuje s `SmTeams`/`SmPlayers` ze staré DB `sportManager`. Log: stovky
  „DB init attempt … relation SmTeams does not exist". `/health` přesto hlásí `db ok` (jen ping).
- ~~`mcp-sportreal` čte `sportReal`~~ — ✅ opraveno 2026-09-16, čte `SportReal` (1856 sportů).
- ~~**MCP servíruje zastaralé prompty**~~ ✅ 2026-09-16 13:14 nasazeno 11.5.x (záloha `governance-backup-20260916-131441.tgz`): `/share/Container/mcp-qnap/governance` (→ `https://mcp.vo2info.cz/governance/`,
  bez přihlášení) má `PromptVersion 11.2.0` z 2026-07-30 a jen 7 promptů; repo i Drive jsou na 11.5.x.
  Agenti stahují nejdřív z MCP → dostávají 11.2.0. Staré kopie `ManagerPrompt.txt`/`CatalogPrompt.txt` v kořeni
  `mcp-qnap/` (nepublikované) obsahují base64 `admin:<starý token>`.

### ⚠️ pg_hba: `trust` pro všechna lokální spojení (zjištěno 2026-09-16)

Aktivní pravidla pg16: `trust` pro `127.0.0.1`, `::1`, **`172.16.0.0/12`** (všechny Docker sítě),
`192.168.60.221` a `172.29.0.0/22`; heslo (`scram-sha-256` pro `roundnet`, `md5` ostatní) jen pro zbytek.
Spojení vzniklá na QNAPu (i na jeho LAN IP) přicházejí přes docker proxy ze `172.29.0.1` → **bez hesla,
pro libovolného uživatele včetně superuživatele**. Z LAN (Mac) server heslo vyžaduje (ověřeno sondou).

Důsledky: kdo ovládne libovolný kontejner na QNAPu, je superuživatel pg16; hesla v konfiguracích aplikací
se na QNAPu vůbec nekontrolují (aplikace se špatným heslem „fungují"); testy přihlášení na QNAPu nic
neprokazují. Náprava = změnit `trust` na `scram-sha-256` pro Docker sítě — předtím ověřit, že každá aplikace
má v konfiguraci platné heslo (dnes to nikdo nekontroluje) a `password_encryption` = scram (je).

### Plán: odstranění `trust` z pg_hba (připraveno 2026-09-16, NEPROVEDENO)

**Inventura spotřebitelů pg16** (env kontejnerů + `appsettings.Production.json` + živá spojení):
`AgentAI` (qnap-game-mcp, vin-importer), `mcp_sr_usr`, `mcp_usm_usr`, `mcp_te_usr`, `agent_mon_usr` a
`mercs_beasts_usr` (mcp-mab), `aps_usr`, `myzabbix_usr`, `scorer_usr`, `sportcar_usr`, `sportgame_usr`,
`sportreal_usr` (BlazorSimulateReal1), `sportmanager_usr`, `topeleven_usr`, `transittycoon_usr`, `vinwmi_usr`,
`vo2data_usr`, `vo2info_usr`, `vo2info_ro`, `gitea` (přes pgbouncer :5433 z 172.29.0.1), `roundnet`
(simulatereal, unisportmanager `AiDataConnection`, migrace). Hesla v konfiguracích dnes nikdo neověřuje.

**Postup po rolích** (bez výpadku, vratný):
1. Před řádky `trust` vložit `host all <role> 172.16.0.0/12 md5` (+ totéž pro `192.168.60.221/32`, `127.0.0.1/32`).
   Metoda `md5` přijme i hesla uložená jako SCRAM; role s MD5 otiskem (`agent_mon_usr`, `aps_usr`,
   `sportgame_usr`, `sportreal_usr`) fungují také.
2. `SELECT pg_reload_conf();` — existující spojení zůstanou, nová se ověřují heslem.
3. Vynutit nové spojení dané aplikace (restart kontejneru / čekat na pool) a sledovat log pg16
   (`password authentication failed for user "<role>"`). Při chybě řádek odebrat, reload, opravit heslo v konfiguraci.
4. Opakovat pro všechny role; pgbouncer (Gitea) ověřit zvlášť (auth soubor pgbouncer).
5. Nakonec řádky `trust` pro `172.16.0.0/12`, `172.29.0.0/22`, `192.168.60.221` nahradit `md5`
   (ponechat `local` trust pro správu přes `docker exec pg16 psql`).

## Jak jsou kontejnery vytvořené (ověřeno 2026-09-15)

- **Superuser pg16 je `roundnet`** — role `postgres` neexistuje (`psql -U roundnet -d postgres`).
- Z compose (`/share/Container/mcp-qnap`) je **jen `qnap-game-mcp`** (služba `mcp`); `.env` tam zatím neexistuje.
- `vin-importer`, `mcp-mab`, `mcp-usm`, `qnap-te-mcp`, `mcp-sportreal`, `mcp-oauth` jsou **`docker run`**
  s env inline — změna hesla/tokenu = kontejner znovu vytvořit (`docker inspect` → stejné parametry, nová hodnota).
  `.env` + `docker compose up` na ně nestačí.
- `vin-importer`: původně `restart=no` (2026-09-15 18:04 nastaveno `docker update --restart unless-stopped`), síť host, mount `/share/CACHEDEV1_DATA/homes/admin/vin-imports`, heslo v env `DB_CONN`
  (`postgresql://AgentAI:${AGENT_DB_PASSWORD}@127.0.0.1:5432/AIData`), image `vin-importer:latest` z `/share/Container/vin-importer`.
  Není v cronu ani v žádném skriptu — je to **poller** (`importer.py import`, interval 60 s).
  2026-09-15 17:41 ukončen (exit 137, reset QNAPu) a kvůli `restart=no` zůstal vypnutý.

### Nové vytvoření `vin-importer` (součást `rotate-secrets.sh agentai`)

```bash
DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
cd /share/Container/vin-importer
umask 077
printf 'DB_CONN=%s\nVIN_IMPORT_DIR=/data/vin-imports\n' "postgresql://AgentAI:${NEW}@127.0.0.1:5432/AIData" > .env
$DOCKER rm -f vin-importer
$DOCKER run -d --name vin-importer --network host --restart unless-stopped \
  --env-file /share/Container/vin-importer/.env \
  -v /share/CACHEDEV1_DATA/homes/admin/vin-imports:/data/vin-imports \
  vin-importer python importer.py import
# ověření po ~70 s: v logu „incoming/ je prázdná" (ne chyba autentizace)
$DOCKER logs --tail 3 vin-importer
```

Změna oproti originálu: `--env-file` místo inline env a `--restart unless-stopped` místo `no`.

## Postup pro `AgentAI` (nejmenší rozsah — 2 kontejnery)

**Preferovaně skriptem** (neinteraktivní, ověří přihlášení novým i odmítnutí starého hesla a `/health`,
jinak automaticky vrátí původní heslo i konfiguraci; nanečisto ověřeno 2026-09-15):

```bash
ssh -i ~/.ssh/claude-qnap admin@192.168.60.221 'sh -s' < scripts/rotate-agentai-qnap.sh
```

Skript se zastaví, pokud se `docker-compose.yml` od kontroly změnil (kontrolní md5) — pak ho
znovu ověřit a hash ve skriptu aktualizovat. Ruční postup níže je pro pochopení kroků.

```bash
DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
NEW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)   # heslo si ulož do Vaultwarden

# 1) nové heslo v pg16
$DOCKER exec pg16 psql -U roundnet -d postgres -c "ALTER USER \"AgentAI\" WITH PASSWORD '$NEW';"

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

## Doplněno 2026-09-14 — rozsah úniku v celé historii

Ověřeno skenem všech 283 commitů (včetně větví a PR) a zkušebním `git filter-repo` na zrcadlové kopii.

**Skutečně uniklé hodnoty jsou tři:**

| Hodnota | Kde všude v historii |
|---|---|
| heslo `AgentAI` | 2 výskyty v obsahu |
| `GITEA_TOKEN` | 2 výskyty v obsahu |
| MCP `AUTH_TOKEN` | 20× jako text + **8× jako base64 `admin:<token>`** ve starých verzích `CatalogPrompt` / `ManagerPrompt` + 1× ve zprávě commitu `a00d6699` |

**MCP token je zároveň heslo admina ntfy** (Basic auth `admin:<token>`). Rotace tokenu tedy musí
zahrnout i ntfy — jinak zůstane ntfy chráněný uniklou hodnotou.

**Přepis historie** musí nahrazovat i zakódované varianty a zprávy commitů
(`--replace-text` + `--replace-message`); samotná náhrada přímého textu nechá base64 i zprávu v historii.
Zkušební přepis s 3 hodnotami + 18 variantami: 57 výskytů → 0, strom aktuálního `main` beze změny.

**Po force-pushi zůstanou staré commity dostupné přes `refs/pull/*`** — všech 10 PR (i zavřených)
má tajemství ve své historii a tyto reference uživatel smazat nemůže. Nutné požádat GitHub Support
o odstranění cached views a PR referencí. Rotace je proto povinná bez ohledu na přepis.

## Stav 2026-09-15 — historie přepsána

- **GitHub:** `git filter-repo` (3 hodnoty + 18 zakódovaných variant, obsah i zprávy commitů), force push.
  Nový `main` = `9cb3654`, obsah stromu shodný s původním `76ac149`. Před přepisem zavřeno všech 5
  zbylých PR i s větvemi.
- **Ověřeno na čerstvém klonu z GitHubu:** větve + tagy → **0 výskytů**.
- **Zbývá 50 výskytů v `refs/pull/1..10/head`** — reference PR na GitHubu jsou read-only, nemají
  s novou historií společného předka a force-push je nesmaže. **Nutný požadavek na GitHub Support**
  (odstranění PR referencí a cached views pro repo `olsanvit/vo2-ai-agent-governance`).
- **Gitea:** force push proveden po obnovení QNAPu; ověřeno na čerstvém klonu — 1 větev, 3 tagy (shodné s GitHubem), žádné další reference, **0 výskytů**.
- **Lokální klony:** každý starší klon má starou historii — `git fetch origin && git reset --hard origin/main`
  (nebo naklonovat znovu). Nikdy z něj nepushovat, jinak se stará historie vrátí.
- **Rotace je dál povinná** — dokud existují PR reference a případné cizí kopie, jsou hodnoty kompromitované.

## Oddělení `roundnet` (příprava, 2026-09-15)

`patches/mcp-least-privilege.sql` vytvoří tři role s právy jen na vlastní DB:

| Role | DB | Práva | Kontejner |
|---|---|---|---|
| `mcp_usm_usr` | UniSportManager | SELECT/INSERT/UPDATE/DELETE | `mcp-usm` |
| `mcp_te_usr` | TopEleven | SELECT/INSERT/UPDATE/DELETE | `qnap-te-mcp` |
| `mcp_sr_usr` | sportReal | jen SELECT (server jen čte) | `mcp-sportreal` |

Pořadí: 1) spustit SQL, 2) v `.env` doplnit hesla, 3) v compose přepsat `DATABASE_URL`
na nové role přes `${PROMĚNNÉ}`, 4) `docker compose up -d` pro tyto tři služby,
5) ověřit `/health` tělem odpovědi, 6) teprve pak rotovat heslo `roundnet` samotné.

`ALTER DEFAULT PRIVILEGES FOR ROLE roundnet` zajistí, že tabulky vytvořené budoucími
migracemi budou pro MCP role dostupné samy — jinak by po každé migraci `mcp_*` role
na nové tabulky neviděly.
