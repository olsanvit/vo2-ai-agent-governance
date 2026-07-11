#!/usr/bin/env python3
"""
audit-generator.py
Skenuje komentáře AUDIT: ve všech .razor a .cs souborech projektu
a generuje statický HTML report.

Formát komentářů:
  Razor: @* AUDIT:STATUS|SEVERITY|Note *@
  C#:    // AUDIT:STATUS|SEVERITY|Note

STATUS: OK | PENDING | CRITICAL | FIXED
SEVERITY: Kritický | Vysoký | Střední | Nízký | — (jen u PENDING/CRITICAL)

Použití:
  python3 audit-generator.py
  python3 audit-generator.py --output /path/to/report.html
"""

import os, re, sys, json
from pathlib import Path
from datetime import datetime, timezone
from html import escape

# ─── Konfigurace ──────────────────────────────────────────────────────────────
BASE = Path("/Users/rtvdata/Projects")

PROJECTS = {
    "SimulateGames":        BASE / "SimulateGames/src/SimulateGames.Web",
    "SimulateReal":         BASE / "SimulateReal/src/SimulateReal.Web",
    "UniSportManager":      BASE / "UniSportManager/src/SportManager.Web",
    "VINWMIVehicles":       BASE / "VINWMIVehicles/src/VINWMIVehicles.Web",
    "TopElevenStats":       BASE / "TopElevenStats/src/TopElevenStats.Web",
    "AgentsPromptsSkills":  BASE / "AgentsPromptsSkills/src/AgentsPromptsSkills.Web",
    "VO2DataManager":       BASE / "VO2DataManager/src/VO2DataManager.Web",
    "ClubManager":          BASE / "ClubManager/src/ClubManager.Web",
    "MercenariesAndBeasts": BASE / "MercenariesAndBeasts/Mercenaries-and-Beasts/src/MercenariesAndBeasts.Web",
    "ScorerApp":            BASE / "ScorerApp/src/ScorerApp.Web",
    "SharedServices":       BASE / "SharedServices/SharedServices",
}

# Regex pro AUDIT komentáře
RAZOR_RE = re.compile(r'@\*\s*AUDIT:([^\*]+)\*@', re.IGNORECASE)
CS_RE    = re.compile(r'//\s*AUDIT:(.+)$', re.IGNORECASE)
PAGE_RE  = re.compile(r'@page\s+"([^"]+)"')
METHOD_RE = re.compile(
    r'^\s*(public|private|protected|internal)\s+'
    r'(?:(?:static|async|virtual|override|abstract)\s+)*'
    r'(?:\S+\s+)?(\w+)\s*[(<]',
    re.MULTILINE
)

STATUS_ORDER = {"CRITICAL": 0, "PENDING": 1, "FIXED": 2, "OK": 3, "?": 4}
SEV_ORDER    = {"Kritický": 0, "Vysoký": 1, "Střední": 2, "Nízký": 3, "—": 4, "": 5}


def parse_audit_tag(raw: str) -> dict:
    """Parsuje 'STATUS|SEVERITY|Note' nebo 'STATUS|Note' nebo jen 'STATUS'."""
    parts = [p.strip() for p in raw.strip().split("|")]
    status   = (parts[0] if parts else "?").upper()
    severity = ""
    note     = ""
    if len(parts) == 3:
        severity, note = parts[1], parts[2]
    elif len(parts) == 2:
        # rozliš severity od note heuristikou
        if parts[1] in ("Kritický", "Vysoký", "Střední", "Nízký", "—"):
            severity = parts[1]
        else:
            note = parts[1]
    return {"status": status, "severity": severity or "—", "note": note}


def scan_razor(path: Path, project: str) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    route = next(iter(PAGE_RE.findall(text)), "")
    rel   = str(path).replace(str(PROJECTS.get(project, "")), "").lstrip("/\\")
    results = []
    for m in RAZOR_RE.finditer(text):
        entry = parse_audit_tag(m.group(1))
        entry.update({"project": project, "file": rel, "route": route, "kind": "page"})
        results.append(entry)
    return results


def scan_cs(path: Path, project: str) -> list[dict]:
    text  = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    rel   = str(path).replace(str(PROJECTS.get(project, "")), "").lstrip("/\\")
    results = []
    for i, line in enumerate(lines):
        m = CS_RE.search(line)
        if not m:
            continue
        entry = parse_audit_tag(m.group(1))
        # hledej následující non-prázdný řádek s metodou/property/třídou
        target = ""
        for j in range(i + 1, min(i + 4, len(lines))):
            mm = METHOD_RE.match(lines[j])
            if mm:
                target = mm.group(2)
                break
            stripped = lines[j].strip()
            if stripped and not stripped.startswith("//") and not stripped.startswith("["):
                target = stripped[:60]
                break
        entry.update({"project": project, "file": rel, "method": target, "kind": "service"})
        results.append(entry)
    return results


def collect_all() -> list[dict]:
    all_entries = []
    for project, root in PROJECTS.items():
        if not root.exists():
            continue
        for razor in root.rglob("*.razor"):
            if any(p in str(razor) for p in ["SharedServices", "obj/", "bin/"]):
                continue
            all_entries.extend(scan_razor(razor, project))
        for cs in root.rglob("*.cs"):
            if any(p in str(cs) for p in ["obj/", "bin/", "Migrations/"]):
                continue
            all_entries.extend(scan_cs(cs, project))
    # SharedServices zvlášť (sdíleno)
    ss = PROJECTS["SharedServices"]
    if ss.exists():
        for cs in ss.rglob("*.cs"):
            if any(p in str(cs) for p in ["obj/", "bin/", "Migrations/"]):
                continue
            all_entries.extend(scan_cs(cs, "SharedServices"))
        for razor in ss.rglob("*.razor"):
            if any(p in str(razor) for p in ["obj/", "bin/"]):
                continue
            all_entries.extend(scan_razor(razor, "SharedServices"))
    return sorted(all_entries,
                  key=lambda e: (STATUS_ORDER.get(e["status"], 9),
                                 SEV_ORDER.get(e.get("severity", ""), 9),
                                 e["project"], e["file"]))


# ─── HTML ─────────────────────────────────────────────────────────────────────

STATUS_BADGE = {
    "CRITICAL": ("🔴 CRITICAL", "#FF4444", "#fff"),
    "PENDING":  ("⚠️ PENDING",  "#FF9900", "#fff"),
    "FIXED":    ("✅ FIXED",    "#22AA44", "#fff"),
    "OK":       ("✅ OK",       "#22AA44", "#fff"),
}
SEV_BADGE = {
    "Kritický": ("#FF4444", "#fff"),
    "Vysoký":   ("#FF9900", "#fff"),
    "Střední":  ("#F0C040", "#333"),
    "Nízký":    ("#88AACC", "#fff"),
    "—":        ("#666",    "#fff"),
}


def badge(text, bg, fg="#fff"):
    return (f'<span style="background:{bg};color:{fg};padding:2px 7px;'
            f'border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap">{escape(text)}</span>')


def build_html(entries: list[dict]) -> str:
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    projects  = sorted({e["project"] for e in entries})
    pages     = [e for e in entries if e.get("kind") == "page"]
    services  = [e for e in entries if e.get("kind") == "service"]

    # statistiky
    def stats(lst):
        return {s: sum(1 for e in lst if e["status"] == s)
                for s in ("CRITICAL", "PENDING", "FIXED", "OK")}
    ps, ss = stats(pages), stats(services)

    def rows(lst, is_page):
        out = []
        for e in lst:
            stxt, sbg, sfg = STATUS_BADGE.get(e["status"],
                             (e["status"], "#888", "#fff"))
            sevbg, sevfg = SEV_BADGE.get(e.get("severity", "—"), ("#888", "#fff"))
            file_cell = escape(e["file"])
            extra = (f'<code style="font-size:10px;color:#8af">{escape(e.get("route",""))}</code>'
                     if is_page else
                     f'<code style="font-size:10px;color:#fa8">{escape(e.get("method",""))}</code>')
            out.append(
                f'<tr data-project="{escape(e["project"])}" '
                f'data-status="{escape(e["status"])}" '
                f'data-sev="{escape(e.get("severity",""))}">'
                f'<td><span style="color:#8af;font-weight:600">{escape(e["project"])}</span></td>'
                f'<td><span style="font-family:monospace;font-size:11px">{file_cell}</span>'
                f'<br>{extra}</td>'
                f'<td>{badge(stxt, sbg, sfg)}</td>'
                f'<td>{badge(e.get("severity","—"), sevbg, sevfg)}</td>'
                f'<td style="font-size:12px;color:#ccc">{escape(e.get("note",""))}</td>'
                f'</tr>'
            )
        return "\n".join(out)

    def stat_box(label, n, color):
        return (f'<div style="background:{color}22;border:1px solid {color};'
                f'border-radius:8px;padding:12px 18px;text-align:center;min-width:90px">'
                f'<div style="font-size:28px;font-weight:700;color:{color}">{n}</div>'
                f'<div style="font-size:11px;color:#aaa;margin-top:2px">{label}</div></div>')

    page_rows    = rows(pages, True)
    service_rows = rows(services, False)

    proj_opts = "".join(f'<option value="{p}">{p}</option>' for p in projects)

    return f"""<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<title>Audit projektů — {generated}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
     background:#0d1117;color:#c9d1d9;min-height:100vh;padding:24px}}
h1{{font-size:22px;font-weight:700;margin-bottom:4px;color:#e6edf3}}
.sub{{font-size:12px;color:#666;margin-bottom:24px}}
.tabs{{display:flex;gap:4px;margin-bottom:16px}}
.tab{{padding:7px 18px;border-radius:6px 6px 0 0;cursor:pointer;font-size:13px;
      font-weight:600;border:1px solid #30363d;border-bottom:none;
      background:#161b22;color:#8b949e;transition:all .15s}}
.tab.active{{background:#21262d;color:#e6edf3;border-color:#58a6ff}}
.panel{{display:none}}.panel.active{{display:block}}
.stats{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}}
.filters{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}}
select,input{{background:#161b22;border:1px solid #30363d;color:#c9d1d9;
             padding:6px 10px;border-radius:6px;font-size:12px;outline:none}}
select:focus,input:focus{{border-color:#58a6ff}}
table{{width:100%;border-collapse:collapse;font-size:12px}}
th{{background:#161b22;border-bottom:2px solid #30363d;padding:8px 10px;
    text-align:left;color:#8b949e;font-weight:600;position:sticky;top:0}}
td{{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}}
tr:hover td{{background:#161b22}}
tr[data-status="CRITICAL"] td:first-child{{border-left:3px solid #FF4444}}
tr[data-status="PENDING"]  td:first-child{{border-left:3px solid #FF9900}}
tr[data-status="FIXED"]    td:first-child{{border-left:3px solid #22AA44}}
tr[data-status="OK"]       td:first-child{{border-left:3px solid #22AA44}}
.hidden{{display:none!important}}
.cnt{{font-size:11px;color:#8b949e;margin-left:8px}}
@media(max-width:600px){{
  .stats{{gap:8px}} td,th{{padding:5px 6px;font-size:11px}}
}}
</style>
</head>
<body>
<h1>🔍 Audit projektů</h1>
<div class="sub">Vygenerováno: {generated} · zdroj: AUDIT komentáře v kódu</div>

<div class="tabs">
  <div class="tab active" onclick="showTab('pages',this)">
    📄 Razor Pages
    <span class="cnt">({len(pages)})</span>
  </div>
  <div class="tab" onclick="showTab('services',this)">
    ⚙️ Services &amp; Methods
    <span class="cnt">({len(services)})</span>
  </div>
</div>

<!-- PAGES -->
<div id="pages" class="panel active">
  <div class="stats">
    {stat_box("CRITICAL", ps["CRITICAL"], "#FF4444")}
    {stat_box("PENDING",  ps["PENDING"],  "#FF9900")}
    {stat_box("FIXED",    ps["FIXED"],    "#22AA44")}
    {stat_box("OK",       ps["OK"],       "#3399FF")}
  </div>
  <div class="filters">
    <select onchange="filter('pages')" id="pages-proj">
      <option value="">Všechny projekty</option>
      {proj_opts}
    </select>
    <select onchange="filter('pages')" id="pages-status">
      <option value="">Všechny stavy</option>
      <option>CRITICAL</option><option>PENDING</option>
      <option>FIXED</option><option>OK</option>
    </select>
    <select onchange="filter('pages')" id="pages-sev">
      <option value="">Všechny závažnosti</option>
      <option>Kritický</option><option>Vysoký</option>
      <option>Střední</option><option>Nízký</option>
    </select>
    <input placeholder="🔍 Hledat..." oninput="filter('pages')" id="pages-search">
  </div>
  <table id="pages-table">
    <thead><tr>
      <th>Projekt</th><th>Soubor / Route</th><th>Stav</th>
      <th>Závažnost</th><th>Poznámka</th>
    </tr></thead>
    <tbody>{page_rows}</tbody>
  </table>
</div>

<!-- SERVICES -->
<div id="services" class="panel">
  <div class="stats">
    {stat_box("CRITICAL", ss["CRITICAL"], "#FF4444")}
    {stat_box("PENDING",  ss["PENDING"],  "#FF9900")}
    {stat_box("FIXED",    ss["FIXED"],    "#22AA44")}
    {stat_box("OK",       ss["OK"],       "#3399FF")}
  </div>
  <div class="filters">
    <select onchange="filter('services')" id="services-proj">
      <option value="">Všechny projekty</option>
      {proj_opts}
    </select>
    <select onchange="filter('services')" id="services-status">
      <option value="">Všechny stavy</option>
      <option>CRITICAL</option><option>PENDING</option>
      <option>FIXED</option><option>OK</option>
    </select>
    <select onchange="filter('services')" id="services-sev">
      <option value="">Všechny závažnosti</option>
      <option>Kritický</option><option>Vysoký</option>
      <option>Střední</option><option>Nízký</option>
    </select>
    <input placeholder="🔍 Hledat..." oninput="filter('services')" id="services-search">
  </div>
  <table id="services-table">
    <thead><tr>
      <th>Projekt</th><th>Soubor / Metoda</th><th>Stav</th>
      <th>Závažnost</th><th>Poznámka</th>
    </tr></thead>
    <tbody>{service_rows}</tbody>
  </table>
</div>

<script>
function showTab(id, el) {{
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  el.classList.add('active');
}}

function filter(tab) {{
  const proj   = document.getElementById(tab+'-proj').value.toLowerCase();
  const status = document.getElementById(tab+'-status').value.toUpperCase();
  const sev    = document.getElementById(tab+'-sev').value;
  const search = document.getElementById(tab+'-search').value.toLowerCase();
  document.querySelectorAll('#'+tab+'-table tbody tr').forEach(row => {{
    const rp = (row.dataset.project||'').toLowerCase();
    const rs = row.dataset.status||'';
    const rv = row.dataset.sev||'';
    const rt = row.innerText.toLowerCase();
    const ok = (!proj   || rp===proj)
            && (!status || rs===status)
            && (!sev    || rv===sev)
            && (!search || rt.includes(search));
    row.classList.toggle('hidden', !ok);
  }});
}}
</script>
</body>
</html>"""


# ─── CLI ──────────────────────────────────────────────────────────────────────

# Výchozí cesty výstupu (vždy se zapisují obě)
DEFAULT_OUTPUTS = [
    Path("/Users/rtvdata/Projects/vo2-ai-agent-governance/audit-report.html"),
    BASE / "VO2DataManager/src/VO2DataManager.Web/wwwroot/audit-report.html",
]

if __name__ == "__main__":
    out_paths = DEFAULT_OUTPUTS[:]
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        out_paths = [Path(sys.argv[idx + 1])]

    print("Skenuji projekty...")
    entries = collect_all()
    print(f"Nalezeno {len(entries)} AUDIT komentářů")

    html = build_html(entries)
    for out_path in out_paths:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html, encoding="utf-8")
        print(f"Report: {out_path}")
