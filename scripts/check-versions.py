#!/usr/bin/env python3
"""Kontrola a srovnání verzí governance promptů.

PROČ existuje: bump na 11.5.0 (commit d64140e) přepsal jen hlavičky souborů. Verze uvnitř
dokumentů — řádek 1 s identitou agenta, nadpis kapitoly 1 a hlavně self-audit kontroly
(`PromptVersion ==`, `SkillsVersion ==`) — zůstaly na 11.2.x. Agenti pak při self-auditu
hlásili nesoulad kvůli chybě v promptu, ne kvůli svému stavu. Ruční bump to spolehlivě
zopakuje, proto skript.

Použití:
    python3 scripts/check-versions.py            # jen zkontroluje, exit 1 při nesouladu (pro CI)
    python3 scripts/check-versions.py --fix X.Y.Z # srovná všechno na zadanou verzi
"""
import json
import pathlib
import re
import sys

GOV = pathlib.Path(__file__).resolve().parent.parent / "governance"

# Místa, kde verze znamená "tohle je aktuální verze" a musí se tedy bumpovat.
# Záměrně sem NEPATŘÍ: příklady verzovací politiky (11.2.1 → 11.2.2 → …), changelogy,
# nadpisy typu "## Off-season detekce -- 11.2.3" (= zavedeno ve verzi) a SchemaVersion/
# RuntimeSafetyVersion/ImageGovernanceVersion (jiné osy, vlastní životní cyklus).
LIVE_PATTERNS = [
    (r'^(Agent: )\d+\.\d+\.\d+( )', r'\g<1>{v}\g<2>'),
    (r'^(PromptVersion: )\d+\.\d+\.\d+$', r'\g<1>{v}'),
    (r'^(SkillsVersion: )\d+\.\d+\.\d+$', r'\g<1>{v}'),
    (r'(CHAPTER 1: QUICK REFERENCE(?: CARD)? (?:—|--) \w+ )\d+\.\d+\.\d+', r'\g<1>{v}'),
    (r'(BLOK 2 — Verze == )\d+\.\d+\.\d+', r'\g<1>{v}'),
    (r'(PromptVersion == )\d+\.\d+\.\d+', r'\g<1>{v}'),
    (r'(SkillsVersion == )\d+\.\d+\.\d+', r'\g<1>{v}'),
    (r'(PromptVersion tohoto promptu == )\d+\.\d+\.\d+', r'\g<1>{v}'),
    (r'(poslední runy mají promptVersion )\d+\.\d+\.\d+', r'\g<1>{v}'),
    (r'(runtime verzi \()\d+\.\d+\.\d+(\))', r'\g<1>{v}\g<2>'),
    (r'^(GovernanceVersion: )\d+\.\d+\.\d+$', r'\g<1>{v}'),
]

# SimulateRealImporter má na řádku 1 vlastní verzi aplikace (1.4.0), ne governance.
SKIP_AGENT_LINE = {"SimulateRealImporterPrompt.txt"}


def target_version() -> str:
    vers = json.loads((GOV / "versions.json").read_text())
    uniq = set(vers.values())
    if len(uniq) != 1:
        print(f"⚠️  versions.json není jednotný: {sorted(uniq)}", file=sys.stderr)
    return sorted(uniq)[-1]


def scan(fix: str | None) -> int:
    version = fix or target_version()
    problems = 0
    for f in sorted(GOV.glob("*.txt")):
        if f.name == "versions.json":
            continue
        text = f.read_text(errors="replace")
        new = text
        for pat, repl in LIVE_PATTERNS:
            if pat.startswith(r'^(Agent: ') and f.name in SKIP_AGENT_LINE:
                continue
            new = re.sub(pat, repl.format(v=version), new, flags=re.M)
        if new != text:
            # Rozdíl = některé "živé" místo drží jinou verzi než cílovou
            stale = sum(1 for a, b in zip(text.splitlines(), new.splitlines()) if a != b)
            problems += stale
            if fix:
                f.write_text(new)
                print(f"  opraveno {f.name}: {stale} řádků → {version}")
            else:
                for a, b in zip(text.splitlines(), new.splitlines()):
                    if a != b:
                        print(f"  {f.name}: {a.strip()[:90]}")
    if problems == 0:
        print(f"✅ všechny živé verze odpovídají {version}")
        return 0
    if fix:
        print(f"✅ srovnáno na {version} ({problems} řádků)")
        return 0
    print(f"❌ {problems} řádků drží jinou verzi než {version}")
    return 1


if __name__ == "__main__":
    fix = None
    if "--fix" in sys.argv:
        i = sys.argv.index("--fix")
        if i + 1 >= len(sys.argv):
            sys.exit("--fix vyžaduje verzi, např. --fix 11.6.0")
        fix = sys.argv[i + 1]
    sys.exit(scan(fix))
