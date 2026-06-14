Systémový prompt byl aktualizován na verzi 9.3.6. Proveď při tomto běhu následující:

1. Stáhni nový prompt z Gitea (fallback: Google Drive):
   - Gitea: `https://gitea.vo2info.cz/olsanvit/vo2-ai-agent-governance/raw/branch/main/`
   - Fallback: `search_files(query="{AgentType}Prompt", folderId="1GKqFES4r1zoEBsWjfOD0qs2-Tc08a8xQ")`

2. **NOVÝ KROK — Synchronizace base entities do DB** (proveď po načtení svých Drive souborů):

   Pro každý svůj Drive Sheet (`_entities`, `_names`, `_urls`):

   a) Načti obsah Sheetu:
   ```
   sheets_get_values(spreadsheetId="<tvůj spreadsheetId>", range="Sheet1")
   ```

   b) Synchronizuj do AgentMonitor DB:
   ```
   sync_agent_entities(
     agent_name="<tvé AgentName>",
     entity_type="entity",   -- nebo "name" / "url"
     rows=<výstup z sheets_get_values.values>,
     value_col=0,            -- index sloupce s hlavní hodnotou
     meta_cols=["ImportantScore","RowCount","LastPopulated"]  -- ostatní sloupce
   )
   ```

   c) Při dalším běhu místo `sheets_get_values` (nebo navíc) použij:
   ```
   get_agent_entities(agent_name="<tvé AgentName>", entity_type="entity")
   ```
   → rychlé čtení z DB bez Drive volání

   **Pravidla synchronizace:**
   - Nový řádek v Sheetu → automaticky přidán do DB při příštím runu
   - Existující řádek → metadata aktualizována (upsert)
   - DB nikdy nesmaže řádek ze Sheetu — jen nastaví `active=false` pokud to agent explicitně udělá
   - Sheet zůstává primárním zdrojem pro operátorovy ruční úpravy
   - DB je pracovní kopie pro agenta (rychlé čtení bez Drive)

   **Inicializace pro nového agenta** — při prvním runu (drive soubory prázdné nebo neexistují):
   - Vytvoř Drive Sheet s hlavičkou dle svého typu (viz níže)
   - Vlož své base entity (výchozí sada dle domény) do Sheetu
   - Zavolej `sync_agent_entities` → propíše do DB

   **Formát hlaviček dle entity_type:**
   | entity_type | Sloupce v Sheetu |
   |-------------|-----------------|
   | entity | Value \| ImportantScore \| RowCount \| LastPopulated |
   | name | Value \| Priority \| Notes |
   | url | Value \| SourceTier \| ReliabilityScore \| Status |
   | error | Value \| ProblemScore \| Category \| Notes |

3. Notifikace: vždy používej `send_notification` — nikdy nevolej ntfy přímo. Pošli PŘED závěrečným reportem:
   - ✅ vše OK → `agent-runs` (priority: default)
   - ⚠️ částečné selhání → `agent-alerts` (priority: high)
   - 🚨 kritický blokér → `agent-errors` (priority: urgent)
   - 🔧 maintenance akce → navíc `agent-maintenance`

   ```
   send_notification(topic="agent-runs", title="✅ {AgentName} — run OK", message="Entities synced: 12 | Nové: 5 | Aktualizované: 12 | Verze: 9.3.6", priority="default", tags=["white_check_mark"])
   ```

4. Potvrď verzi promptu, výsledek sync_agent_entities (inserted/updated) a výsledek kontroly souborů v závěrečném reportu.
