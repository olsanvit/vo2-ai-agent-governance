# SimulateRealImporterPrompt — dokumentace

**Verze:** 12.0.0  
**AgentType:** Importer  
**Soubor:** `governance/SimulateRealImporterPrompt.txt`

---

## Co dělá

SimulateRealImporter je specializovaný DB-to-DB import agent. Čte dokončené sportovní data ze SportReal DB (přes qnap-sr / VO2QNAPDBSR read-only konektor) a zapisuje je do AIData DB (přes qnap-ai / VO2QNAPDBAI). NEVYTVÁŘÍ nové tabulky — zapisuje výhradně do tabulek, které v AIData již existují. Před každým zápisem ověřuje duplicitu dle business klíče (ne jen Id), přičemž Id ze SportReal přepisuje lokálními Id cílových tabulek.

Zpracovává až 30+ sportů v jednom runu (teamové i závodní sporty). Pro každý sport provádí postupný import: nejprve Leagues → Teams → Players → Matches (pořadí je závazné kvůli Id mappingům). Spouští se denně v 04:00 UTC.

---

## Konfigurace

Konfigurace je přímá (bez externího config souboru — parametry jsou součástí promptu nebo systémových tabulek).

| Parametr | Výchozí | Popis |
|---|---|---|
| `MaxMatchesPerSport` | 5000 | max zápasů na sport na run (ochrana před long-tail historií) |
| `FirstRunLookback` | 90 dní | zpětné okno při prvním importu sportu |
| `SchemaCacheTTL` | 7 dní | platnost cache výsledků DISCOVERY |
| `CheckpointTTL` | 4 hodiny | max stáří checkpointu pro Checkpoint Recovery |
| `TeamMappingCacheTTL` | 4 hodiny | platnost in-memory team/league Id mappingu |
| `CircuitBreakerThreshold` | 5 selhání | počet selhání → circuit open |
| `CircuitBreakerOpenDuration` | 24 hodin | délka otevřeného circuit breakeru |

---

## Průběh (Happy Path)

**Startup sekvence:**

1. BLOK 2 self-audit — ověření verze promptu (>= 12.0.0), SharedGovernanceCore (>= 12.0.0)
2. BLOK 1c Capability Check — db_ping na oba konektory; chybí-li → STOP
3. BLOK 2f Prompt Integrity Check — SHA256 promptu vs. compatibility.json
4. Advisory Lock — `pg_try_advisory_lock(hashtext('SRImporter'))` přes qnap-ai
5. Ensure systémové tabulky: SR_ImporterRuns, SR_SchemaCache, SR_CircuitBreakers
6. Schema Cache Check — platná cache (< 7 dní) → přeskočit DISCOVERY
7. Schema Drift Detection — porovnat hash sloupců cílových tabulek s cachí; drift → invalidovat
8. DISCOVERY — list_tables (AIData) → průnik s sr_list_sports (SportReal)
9. Checkpoint Recovery Check — pokračovat od nedokončeného sportu (z předchozího přerušeného runu)
10. Načíst LastSyncAt pro každý sport ze SR_ImporterRuns
11. Token Budget Init — EstimatedTokensUsed = 0, StartedAt = now()

**Run sekvence (pro každý sport):**

1. Circuit Breaker Check — status open → přeskočit sport
2. Pre-flight Sport Count — COUNT nových zápasů; 0 → přeskočit sport
3. get_table_schema obou stran → schema mapping (průnik sloupců)
4. Import Leagues → sestavit leagueId mapping
5. Import LeagueSeasons (pokud tabulka existuje)
6. Import Teams → sestavit teamId mapping
7. Import Players
8. Import Matches (stránkování po 200, limit MaxMatchesPerSport)
   - Přepis HomeTeamId + AwayTeamId + LeagueId přes Id mapping
   - Bulk dedup (smart_upsert_batch po 100)
9. Upsert do SR_ImporterRuns (Success=true, counts, CompletedAt=now())
10. Checkpoint mark — CompletedAt nastaven → sport uzavřen

**Po všech sportech:**

11. Import Coverage Score — výpočet ok/total za 7 dní; < 70 % → ntfy warning
12. SR_ImporterRuns Archivace (každých 30 runů) — smazat záznamy starší 90 dní
13. Token Budget Alert — pokud EstimatedCostUSD > $0.50 → ntfy warning
14. NTFY — jedna zpráva na konec celého runu (ne per-sport)
15. Advisory Lock Release

---

## Větvení a výjimky

### Chybí RequiredCapability (qnap-sr nebo qnap-ai nedostupný)
- STOP před startem
- ntfy urgent: "missing_required_capability:{name}"
- DR Protocol: čekat na obnovení, pak standardní startup

### Advisory lock obsazen
- Jiná instance běží → okamžitě STOP
- ntfy warning: "already_running"
- Run report: lock_status = skipped

### Schema Drift Detection
- Hash sloupců cílové tabulky se změnil oproti SR_SchemaCache
- Invalidovat cache, spustit DISCOVERY
- Logovat: `schema_drift_detected:{sport}`

### Circuit Breaker — sport open
- Sport přeskočen bez pokusu o import
- Logovat: `circuit_open:{sport}`
- Po 24 h: status → half-open, zkusit znovu

### Circuit Breaker — sport half-open
- Zkusit import; úspěch → closed, FailCount → 0
- Selhání → open znovu, OpenedAt → now()

### Circuit Breaker — 5. selhání
- Status → open, ntfy warning: "circuit_open:{sport}"

### Pre-flight Sport Count — 0 nových dat
- Sport přeskočen: `no_new_data:{sport}`
- Pokračovat dalším sportem

### MaxMatchesPerSport překročen
- Stránkování zastaveno pro daný sport
- Logovat: `max_matches_reached:{sport}:{count}`
- Sport uzavřen jako Success=true (co bylo, importováno)

### Checkpoint Recovery
- Detekce nedokončeného runu (CompletedAt IS NULL AND StartedAt < 4h)
- Import začíná od prvního nedokončeného sportu
- Sporty s CompletedAt = now() přeskočeny

### Schema mismatch (prázdný průnik sloupců)
- Sport přeskočen: `schema_mismatch:{sport}`

### Dedup sloupce nenalezeny
- Sport přeskočen: `dedup_columns_missing:{sport}`, ntfy warning

### Team mapping chybí
- Matches přeskočeny pro daný sport: `team_mapping_missing:{sport}`
- Leagues, Teams, Players importovány normálně

### SR TeamId není v mapě
- Zápas přeskočen: `team_id_not_mapped:{match_id}`

### VO2QNAPDBAI write error — Exponential Backoff
- Retry 3× s prodlevami 2s / 4s / 8s
- Po 3. selhání: přeskočit záznam, log chyby
- Při selhání celého sportu → Circuit Breaker FailCount += 1

### Rate limit VO2QNAPDBSR
- Počkat 5s, retry

### Import Coverage Score — sport pod 70 %
- ntfy warning: "nízké pokrytí {sport}: {pct}% za 7 dní"

### Token Budget překročen (> $0.50/run)
- ntfy warning (agent-alerts): "token budget překročen: ${cost}"

### Partial run
- ntfy warning (agent-alerts)
- SR_ImporterRuns: Success=false pro přerušené sporty

### DR STOP (oba konektory nedostupné)
- Okamžité ukončení
- ntfy urgent pokud dostupná
- Lokální log: `{"level":"error","event":"dr_stop","agent":"SRImporter"}`

---

## Eskalace a ntfy

| Stav | Topic | Priorita |
|---|---|---|
| Run OK | `agent-runs` | default |
| Partial run | `agent-alerts` | high |
| Circuit breaker open | `agent-alerts` | high |
| Nízké pokrytí sportu | `agent-alerts` | high |
| Token budget překročen | `agent-alerts` | high |
| Schema drift | `agent-alerts` | high (warning) |
| Advisory lock obsazen | `agent-alerts` | default |
| Kritická chyba / DR | `agent-errors` | urgent |

NTFY zprávy jsou plain text (title ≤ 60 znaků, message ≤ 200 znaků). `agent-errors` a `agent-alerts` jsou automaticky přeposílány na Telegram relay na QNAPu.

---

## Klíčové pojmy

| Pojem | Vysvětlení |
|---|---|
| `SR_ImporterRuns` | log runů — delta sync, checkpoint, Coverage Score |
| `SR_SchemaCache` | cache výsledků DISCOVERY (schema mapping per sport, TTL 7 dní) |
| `SR_CircuitBreakers` | per-sport circuit breaker stav (closed/open/half-open) |
| `DISCOVERY` | list_tables (AIData) ∩ sr_list_sports (SportReal) = seznam importovatelných sportů |
| `Business klíč` | dedup bez Id: Leagues: Name+Country, Teams: Name+Country, Matches: HomeTeam+AwayTeam+Date |
| `Id mapping` | in-memory přepis srLeagueId → dstLeagueId, srTeamId → dstTeamId (TTL 4h) |
| `Bulk dedup` | načíst existující záznamy najednou (LIMIT 5000), porovnat in-memory, zapsat dávkově |
| `smart_upsert_batch` | dávkové upserty po 100 záznamech |
| `Checkpoint Recovery` | resume od nedokončeného sportu po přerušení runu |
| `Circuit Breaker` | 5 selhání → open 24h → half-open → closed (per sport) |
| `Schema Drift Detection` | detekce změn sloupců cílových tabulek od poslední cache |
| `MaxMatchesPerSport` | ochrana před nekonečným importem (výchozí 5000) |
| `Pattern A` | týmové sporty: Matches / Teams / Players / Leagues |
| `Pattern B` | závodní sporty: Races / Racers — vlastní dedup podmínka |

---

## Závislosti

- **Čtení:** SportReal DB přes qnap-sr / VO2QNAPDBSR (read-only)
- **Zápis:** AIData DB přes qnap-ai / VO2QNAPDBAI
- **Tabulky DB (zápis):** cílové sportovní tabulky (`{Sport}Matches`, `{Sport}Teams` atd.), `SR_ImporterRuns`, `SR_SchemaCache`, `SR_CircuitBreakers`
- **MCP nástroje:** `db_ping`, `run_select_sql`, `list_tables`, `get_table_schema`, `upsert_record`, `smart_upsert_batch`, `send_notification`, `sr_get_matches`, `sr_get_teams`, `sr_get_players`, `sr_get_leagues`, `sr_list_sports`
- **SharedGovernanceCore:** načítat dle Prompt Cache Protocol (step 2b), verze >= 12.0.0
- **compatibility.json:** pro BLOK 2f integrity check (SHA256)
