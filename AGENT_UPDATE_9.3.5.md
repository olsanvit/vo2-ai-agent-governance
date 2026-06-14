Systémový prompt byl aktualizován na verzi 9.3.5. Proveď při tomto běhu následující:

1. Stáhni nový prompt z Google Drive (složka 1GKqFES4r1zoEBsWjfOD0qs2-Tc08a8xQ) — soubory {AgentType}Prompt.txt a {AgentType}PromptSkills.txt. Aktivuj nový obsah jako runtime prompt.

2. Zkontroluj, zda existují tvoje per-agent soubory na Google Drive. Pokud chybí, zapiš do reportu která chybí — operátor je vytvoří ručně. Ty je sám nevytváříš.
   - {AgentName}_entities (Google Sheet) ve složce https://drive.google.com/drive/u/0/folders/1-vX64o8hs25FPkAVH52P9lXUhLCC1FjH pro všechny agenty mimo Manager agenty
   - {AgentName}_entities (Google Sheet) ve složce https://drive.google.com/drive/u/0/folders/1lEvffJ-rjdExCwMWxmWM7PchnKkGTGUO pro Manager agenty
   - {AgentName}_names (Google Sheet) ve složce https://drive.google.com/drive/u/0/folders/1-3GkQT-OqVpkaKwLKkgW8jjbWzNN7BYY
   - {AgentName}_urls (Google Sheet) ve složce https://drive.google.com/drive/u/0/folders/1kYViGZR02wNjr1X0PEqJzBQYmjxobm5U
   - {AgentName}_error.txt ve složce https://drive.google.com/drive/u/0/folders/1w91GGAKnReBc6bWFtrucjlVMYr7NhURj — vytvoří operátor až při prvním selhání

3. Notifikace: vždy používej MCP tool send_notification — nikdy nevolej ntfy přímo. Server je https://ntfy.vo2info.cz, auth je interně v MCP serveru. Pošli PŘED závěrečným reportem v chatu na správné téma dle výsledku:
   - ✅ vše OK → agent-runs (priority: default)
   - ⚠️ částečné selhání / chyby → agent-alerts (priority: high)
   - 🚨 kritický blokér (DB down, run zastaven) → agent-errors (priority: urgent)
   - 🔧 pokud jsi provedl maintenance akci → navíc agent-maintenance
   - Pokud send_notification vrátí 403 → log capability_missing("ntfy_auth"), informuj operátora v reportu
   - Pokud tool není dostupný → log capability_missing("ntfy"), pokračuj (neblokovat run)

Potvrď verzi promptu a výsledek kontroly souborů v závěrečném reportu.
