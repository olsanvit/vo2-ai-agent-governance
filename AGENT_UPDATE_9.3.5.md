Systémový prompt byl aktualizován na verzi 9.3.5. Proveď při tomto běhu následující:

1. Stáhni nový prompt z Google Drive (složka 1GKqFES4r1zoEBsWjfOD0qs2-Tc08a8xQ) — soubory {AgentType}Prompt.txt a {AgentType}PromptSkills.txt. Aktivuj nový obsah jako runtime prompt.

2. Zkontroluj, zda existují tvoje per-agent soubory na Google Drive. Pokud chybí, vytvoř je v cílové složce. Pokud vytvoření se složkou selže, zkus vytvořit bez určení složky (soubor přistane v root My Drive, operátor ho přesune). Cílové složky:
   - {AgentName}_entities (Google Sheet) → https://drive.google.com/drive/u/0/folders/1-vX64o8hs25FPkAVH52P9lXUhLCC1FjH (všichni mimo Manager)
   - {AgentName}_entities (Google Sheet) → https://drive.google.com/drive/u/0/folders/1lEvffJ-rjdExCwMWxmWM7PchnKkGTGUO (Manager agenti)
   - {AgentName}_names (Google Sheet) → https://drive.google.com/drive/u/0/folders/1-3GkQT-OqVpkaKwLKkgW8jjbWzNN7BYY
   - {AgentName}_urls (Google Sheet) → https://drive.google.com/drive/u/0/folders/1kYViGZR02wNjr1X0PEqJzBQYmjxobm5U
   - {AgentName}_error.txt → https://drive.google.com/drive/u/0/folders/1w91GGAKnReBc6bWFtrucjlVMYr7NhURj — vytvoř až při prvním selhání
   - případné další soubory dle tvého typu (mapping, prompts, categories)
   Pokud i vytvoření bez složky selže → zapiš do reportu která chybí, pokračuj dál.

3. Notifikace: vždy používej MCP tool send_notification — nikdy nevolej ntfy přímo vlastním HTTP requestem. Pošli PŘED závěrečným reportem v chatu na správné téma dle výsledku:
   - ✅ vše OK → agent-runs (priority: default)
   - ⚠️ částečné selhání / chyby → agent-alerts (priority: high)
   - 🚨 kritický blokér (DB down, run zastaven) → agent-errors (priority: urgent)
   - 🔧 pokud jsi provedl maintenance akci → navíc agent-maintenance
   - Pokud send_notification vrátí 403 → log capability_missing("ntfy_auth"), informuj operátora v reportu
   - Pokud tool není dostupný → log capability_missing("ntfy"), pokračuj (neblokovat run)

   Správné volání toolu:
   ```
   send_notification(topic="agent-runs", title="✅ {AgentName} — run OK", message="Nové: 5 | Aktualizované: 12 | Doba: 45s | Verze: 9.3.5", priority="default", tags=["white_check_mark"])
   send_notification(topic="agent-alerts", title="⚠️ {AgentName} — run selhal", message="Blokér: missing_files | Zpracováno: 0", priority="high", tags=["warning"])
   send_notification(topic="agent-errors", title="🚨 {AgentName} — kritická chyba", message="DB: unreachable | Akce: zkontrolovat MCP konektor", priority="urgent", tags=["rotating_light"])
   ```

Potvrď verzi promptu a výsledek kontroly souborů v závěrečném reportu.
