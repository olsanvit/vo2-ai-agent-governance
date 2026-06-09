# vo2-governance 9.2.0

Released: 2026-06-09

## Summary

Additive/patch runtime governance sjednocení po opakovaných degradovaných/blocked bězích agentů.
Všechny změny jsou additive — existující sekce zachovány, pouze konfliktní/zastaralé instrukce opraveny.

## Changes

### 1. Version bump: 9.1.0 → 9.2.0
- PromptVersion: 9.2.0 ve všech 6 *Prompt.txt souborech
- SkillsVersion: 9.2.0 ve všech 6 *PromptSkills.txt souborech

### 2. CatalogPrompt.txt — oprava 8.4.0 autoritativních referencí
- Canonical Versioning Reference: GovernanceVersion, SchemaVersion, RuntimeSafetyVersion → 9.2.0
- Final Canonical Reference: aktualizováno na 9.2.0, odstraněno uložené CanonicalFileId
- Role a Konfigurace: PromptVersion → 9.2.0
- MCP Compatibility Check section: přeznačeno jako legacy, aktualizováno na 9.2.0
- Prompt Integrity section: CanonicalFileId → instrukce pro search_files()

### 3. AgentSchedules conflict window: ±1 min → ±15 min (PATCH 9.2.0 Override)
- Přidáno do všech 12 souborů (PATCH 9.2.0 sekce)
- Původní ±1 min bylo příliš striktní (false positives)
- Skills: agent-schedule-manager skill aktualizován v 6 *PromptSkills.txt

### 4. Calendar Universal Rule (všechny AgentType)
- NIKDY nepoužívat zobrazovaný název (AI Catalogs/Managers/...) jako calendar_id
- VŽDY list_calendars() → CALENDAR_ID proměnná
- Doplněno do všech 12 souborů; u Collector rozšiřuje PATCH 9.1.0

### 5. Per-agent files: canonical naming a folder assignment
- _error.txt (singular) — NIKDY _errors.txt
- Explicitní folder ID pro každý AgentType (_entities subfolder)
- Pravidlo: POUZE text/plain s parent folderem + read-back ověřením
- NEVYTVÁŘET Google Doc jako náhradu

### 6. Canonical file formats
- _entities.txt: ImportantScore | TableName | Description | RowCount | LastPopulated | Status
- _names.txt: EntityName | EntityType | PriorityScore | Status | Coverage | LastProcessed | Notes
- _urls.txt: URL | SourceTier | ReliabilityScore | EntityType | LastChecked | Status | Notes
- _error.txt: ProblemScore | Category | Description | Timestamp | StepStatus

### 7. Problem report — Drive write rule
- text/plain + parent folder + read-back povinné
- Fallback Google Doc pouze jako "fallback/unconfirmed artifact"
- Vždy uložit do AgentRunReports.Metadata pokud DB dostupná

### 8. Readiness gating — fallback mode fields
- confirmed_actions | skipped_actions | failed_actions | inferred_findings
- Přidáno do všech 12 souborů

### 9. DB Failure startup stop rules
- Explicitní seznam co zastavit při db_unreachable
- Co je povoleno bez DB (Drive read-only, textový report, ntfy)

### 10. Canonical prompt lookup per AgentType tabulka
- Explicitní mapování agent type → soubory
- Fallback pořadí: Gitea → Drive → DB cache → degraded

### 11. ImporterPrompt: rollback rule
- Rollback NIKDY nepoužívá DELETE
- Soft/status-based: ImportStatus="rolled_back", IsDeleted=true s audit trail
- Soubory se nesmí přesouvat při DB write/read-back selhání

### 12. GeneratorPrompt: image overwrite rule
- Default: NIKDY nepřepisovat existující obrázek
- Re-generate mode: POUZE při explicitním zapnutí operátorem
- Zachovat ImageHistory, reportovat overwrite_blocked/overwrite_allowed_operator

### 13. CollectorPrompt: batch upsert fallback
- smart_upsert_batch 502 → jednotlivé inserty POUZE při: validace + duplicity + business key + read-back
- Reportovat jako batch_upsert_failed_but_single_insert_succeeded
- Nový skill batch-upsert-fallback v CollectorPromptSkills.txt

## Files Modified

- CommonCatalog/CatalogPrompt.txt
- CommonCatalog/CatalogPromptSkills.txt
- CommonCatalog/CheckerPrompt.txt
- CommonCatalog/CheckerPromptSkills.txt
- CommonCatalog/CollectorPrompt.txt
- CommonCatalog/CollectorPromptSkills.txt
- CommonCatalog/GeneratorPrompt.txt
- CommonCatalog/GeneratorPromptSkills.txt
- CommonCatalog/ImporterPrompt.txt
- CommonCatalog/ImporterPromptSkills.txt
- SportManager/ManagerPrompt.txt
- SportManager/ManagerPromptSkills.txt
- VERSION (9.1.0 → 9.2.0)

## Backward Compatibility

✅ Všechny změny jsou additive/patch — existující governance kapitoly zachovány.
✅ PATCH 9.0.0 a PATCH 9.1.0 sekce zachovány beze změny.
✅ Historické changelog položky zachovány.
✅ Žádné breaking changes ve schématu nebo API.
