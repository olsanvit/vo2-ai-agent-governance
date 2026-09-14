#!/usr/bin/env python3
"""Kontrola a srovnání verzí governance promptů.

PROČ existuje: bump na 11.5.0 (commit d64140e) přepsal jen hlavičky souborů. Verze uvnitř
dokumentů — řádek 1 s identitou agenta, nadpis kapitoly 1 a hlavně self-audit kontroly
(`PromptVersion ==`, `SkillsVersion ==`) — zůstaly na 11.2.x. Agenti pak při self-auditu
hlásili nesoulad kvůli chybě v promptu, ne kvůli svému stavu. Ruční bump to spolehlivě
zopakuje, proto skript.

PROČ per-file: verze se mezi soubory běžně rozcházejí (ManagerPrompt 11.5.1 vs ostatní
11.5.0). Zdroj pravdy je tedy záznam daného souboru ve versions.json, ne jedno číslo
pro celé repo. Kontrola `SkillsVersion ==` uvnitř promptu se navíc porovnává s verzí
*Skills souboru*, ne promptu — jsou to dvě nezávislé řady.

Použití:
    python3 scripts/check-versions.py                    # kontrola, exit 1 při nesouladu (CI)
    python3 scripts/check-versions.py --fix              # srovná podle versions.json
    python3 scripts/check-versions.py --bump Manager 11.5.2   # zvedne jeden prompt + jeho reference
"""
import json
import pathlib
import re
import sys

GOV = pathlib.Path(__file__).resolve().parent.parent / "governance"
VERSIONS = GOV / "versions.json"

# Místa, kde verze znamená "tohle je aktuální verze tohoto promptu".
# Záměrně sem NEPATŘÍ: příklady verzovací politiky (11.2.1 → 11.2.2 → …), changelogy,
# nadpisy typu "## Off-season detekce -- 11.2.3" (= zavedeno ve verzi) a SchemaVersion /
# RuntimeSafetyVersion / ImageGovernanceVersion (jiné osy, vlastní životní cyklus).
PROMPT_PATTERNS = [
    r'^(Agent: )%s( )',
    r'^(PromptVersion: )%s$',
    r'(CHAPTER 1: QUICK REFERENCE(?: CARD)? (?:—|--) \w+ )%s',
    r'(BLOK 2 — Verze == )%s',
    r'(PromptVersion tohoto promptu == )%s',
    r'(poslední runy mají promptVersion )%s',
    r'(runtime verzi \()%s(\))',
    r'(Verze: )%s',
]

# GovernanceVersion NENÍ verze promptu, ale verze celého governance release — jeden prompt
# může mít patch (11.5.1) uvnitř release 11.5.0. Kontroluje se proto zvlášť: musí být
# jednotná napříč soubory, ale nesleduje versions.json.
SKILLS_PATTERNS = [r'^(SkillsVersion: )%s$']
# Kontrola Skills uvnitř promptu — porovnává se s verzí Skills souboru
SKILLS_REF_IN_PROMPT = r'(SkillsVersion (?:z načteného [\w ]*souboru|načteného souboru) == )%s'

# SimulateRealImporter má na řádku 1 vlastní verzi aplikace (1.4.0), ne governance.
SKIP_AGENT_LINE = {"SimulateRealImporterPrompt"}

ANY = r'\d+\.\d+\.\d+'


def versions() -> dict:
    return json.loads(VERSIONS.read_text())


def expected_for(name: str, vers: dict) -> tuple[str, str | None]:
    """Vrátí (verze souboru, verze odpovídajícího Skills souboru)."""
    own = vers.get(name)
    skills = vers.get(name + "Skills") if not name.endswith("Skills") else None
    return own, skills


def process(fix: bool) -> int:
    vers = versions()
    problems = []
    for f in sorted(GOV.glob("*.txt")):
        name = f.stem
        own, skills_v = expected_for(name, vers)
        if own is None:
            continue
        text = f.read_text(errors="replace")
        new = text
        pats = SKILLS_PATTERNS if name.endswith("Skills") else PROMPT_PATTERNS
        for pat in pats:
            if pat.startswith(r'^(Agent: ') and name in SKIP_AGENT_LINE:
                continue
            groups = pat.count("(") - pat.count("(?:")
            repl = "".join(f"\\g<{i}>" if i == 1 else (own if i == 2 else f"\\g<{i}>")
                           for i in range(1, groups + 1)) if groups > 1 else f"\\g<1>{own}"
            # jednodušeji: nahradit číslo verze uvnitř vzoru
            new = re.sub(pat % ANY, lambda m, v=own: re.sub(ANY, v, m.group(0)), new, flags=re.M)
        if skills_v:
            new = re.sub(SKILLS_REF_IN_PROMPT % ANY,
                         lambda m, v=skills_v: re.sub(ANY, v, m.group(0)), new, flags=re.M)
        if new != text:
            diff = [(a, b) for a, b in zip(text.splitlines(), new.splitlines()) if a != b]
            problems += [(name, a.strip()[:88]) for a, _ in diff]
            if fix:
                f.write_text(new)
                print(f"  opraveno {f.name}: {len(diff)} řádků")
    # GovernanceVersion — jen jednotnost napříč soubory
    govs = {}
    for f in sorted(GOV.glob("*.txt")):
        for m in re.finditer(r'^(?:- )?GovernanceVersion: (\d+\.\d+\.\d+)$', f.read_text(errors="replace"), re.M):
            govs.setdefault(m.group(1), []).append(f.stem)
    if len(govs) > 1:
        print(f"⚠️  GovernanceVersion není jednotná: { {k: sorted(set(v)) for k, v in govs.items()} }")

    if not problems:
        print("✅ všechny živé verze odpovídají versions.json")
        return 0
    if fix:
        print(f"✅ srovnáno ({len(problems)} řádků)")
        return 0
    for name, line in problems:
        print(f"  {name}: {line}")
    print(f"❌ {len(problems)} řádků neodpovídá versions.json")
    return 1


def bump(prompt: str, version: str) -> int:
    """Zvedne verzi jednoho promptu ve versions.json a srovná jeho reference."""
    key = prompt if prompt.endswith("Prompt") or prompt.endswith("Skills") else prompt + "Prompt"
    vers = versions()
    if key not in vers:
        sys.exit(f"{key} není ve versions.json — dostupné: {', '.join(sorted(vers))}")
    vers[key] = version
    VERSIONS.write_text(json.dumps(vers, indent=2, ensure_ascii=False) + "\n")
    print(f"versions.json: {key} → {version}")
    return process(fix=True)


if __name__ == "__main__":
    if "--bump" in sys.argv:
        i = sys.argv.index("--bump")
        if i + 2 >= len(sys.argv):
            sys.exit("--bump vyžaduje název promptu a verzi, např. --bump Manager 11.5.2")
        sys.exit(bump(sys.argv[i + 1], sys.argv[i + 2]))
    sys.exit(process(fix="--fix" in sys.argv))
