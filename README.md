# VO2 AI Agent Governance

Canonical repository for VO2 AI agent governance prompts and runtime.

## Current release

Version: `11.2.0`

## Canonical active files

- `governance/CatalogPrompt.txt` + `governance/CatalogPromptSkills.txt`
- `governance/ManagerPrompt.txt` + `governance/ManagerPromptSkills.txt`
- `governance/CollectorPrompt.txt` + `governance/CollectorPromptSkills.txt`
- `governance/CheckerPrompt.txt` + `governance/CheckerPromptSkills.txt`
- `governance/GeneratorPrompt.txt` + `governance/GeneratorPromptSkills.txt`
- `governance/ImporterPrompt.txt` + `governance/ImporterPromptSkills.txt`
- `governance/versions.json` — per-prompt version registry
- `mcp-image/mcp-usm.js` — VO2QNAPUSM MCP server (USM DB, Sheets, ntfy, scheduling)
- `mcp-image/mcp-mab.js` — VO2QNAPDB MCP server
- `server.js`

## Source of truth policy

GitHub is the canonical source of truth.
Google Drive is a mirror/distribution layer.

## Language policy

- GovernanceLanguage: English
- RuntimeIdentifiersLanguage: English
- DatabaseNamingLanguage: English
- ScheduledOutputLanguage: Czech
- OperatorReportLanguage: Czech
- UserConversationLanguage: Czech
- CanonicalPromptFileLanguage: English
- ServerSourceLanguage: English

## Warning policy

Warnings are blockers when they affect correctness, auditability, privacy, licensing, lineage, confidence, canonical identity, scheduled output reliability or report trustworthiness.
