Systémový prompt byl aktualizován na verzi 9.4.0. Proveď při tomto běhu následující:

1. Stáhni nový prompt z Gitea (fallback: Google Drive):
   - Gitea raw: `https://gitea.vo2info.cz/olsanvit/vo2-ai-agent-governance/raw/branch/main/`
     - CatalogPrompt:  .../governance/CatalogPrompt.txt
     - ManagerPrompt:  .../governance/ManagerPrompt.txt
   - Fallback Drive: `search_files(query="{AgentType}Prompt", folderId="1GKqFES4r1zoEBsWjfOD0qs2-Tc08a8xQ")`

2. Klíčové změny v 9.4.0:

   a) **Gitea jako primární canonical zdroj promptu** (bylo: Drive jako jediný zdroj)
      - Priorita: Gitea → Drive → DB cache → Bootstrap
      - Prompt Cache Protocol: zkontroluj DB cache verzi, pak Gitea header; stáhni jen při version mismatch

   b) **sync_agent_entities + get_agent_entities přidány do Self-Audit:**
      - BLOK 3: oba nástroje v seznamu 16 kritických tools
      - BLOK 5: sync_agent_entities se volá ihned po sheets_get_values (5a entit, 5b names, 5c urls)
      - BLOK 5d (nový): get_agent_entities ověřuje AgentMonitor DB po každém sync
      - Fallback při nedostupnosti AGENT_MONITOR_URL: degraded mode (log + continue)

   c) **AgentType detection rozšířen** (ManagerPrompt):
      - Přidány typy: Generator, Checker, Importer (bylo: Catalog, Manager, Collector, Analytics)

   d) **MCP Tools Overview** (CatalogPrompt Ch. 8, ManagerPrompt Ch. 13):
      - Počet nástrojů: 63 → 65
      - Nová sekce: `── AGENT MONITOR ──`
      - sync_agent_entities, get_agent_entities označeny jako ✅ kritický

   e) **Drive fallback pro entitní soubory** (CatalogPrompt):
      - Pokud Drive soubory nedostupné → `get_agent_entities` z AgentMonitor DB cache

3. Pravidla synchronizace entit (beze změny od 9.3.6):
   - Nový řádek v Sheetu → automaticky přidán do DB při příštím runu
   - DB nikdy nesmaže řádek ze Sheetu
   - Sheet = primární zdroj pro ruční úpravy operátora
   - DB = pracovní kopie pro rychlé čtení agenta bez Drive volání

4. Notifikace po dokončení:
   ```
   send_notification(
     topic="agent-runs",
     title="✅ {AgentName} — 9.4.0 upgrade OK",
     message="Entities synced | AgentMonitor: OK | Verze: 9.4.0",
     priority="default",
     tags=["white_check_mark"]
   )
   ```

5. Potvrď v závěrečném reportu:
   - Verze promptu: 9.4.0
   - Canonical source použitý při startu (Gitea / Drive / cache)
   - Výsledek sync_agent_entities (inserted/updated)
   - AgentMonitor status: OK / degraded
