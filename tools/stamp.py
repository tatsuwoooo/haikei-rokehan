"""Put a new version stamp on every file the page loads (run before each commit that changes docs/).

GitHub Pages lets browsers keep each file for 10 minutes, and phones often keep a page open for much longer.
With the stamp in every URL (app.js?v=..., ./lib/geo.js?v=...), a page always loads one matching set of files,
and docs/version.json tells an open page that a newer version is out (app.js reloads it once).

    python tools/stamp.py            # stamp = current time (yyyymmddhhmm)
"""
import json, os, re, sys, time

DOCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")
v = sys.argv[1] if len(sys.argv) > 1 else time.strftime("%Y%m%d%H%M")

# relative module imports and the page's own links: add or replace ?v=
IMPORT = re.compile(r'((?:from\s+|import\(\s*)"\./[^"?]+\.js)(?:\?v=[0-9A-Za-z]+)?(")')
LINK = re.compile(r'((?:src|href)="(?:app\.js|style\.css))(?:\?v=[0-9A-Za-z]+)?(")')
CONST = re.compile(r'(const APP_VERSION = ")[0-9A-Za-z]*(")')

changed = []
for root, _, files in os.walk(DOCS):
    for f in files:
        if not f.endswith((".js", ".html")):
            continue
        p = os.path.join(root, f)
        raw = open(p, "rb").read().decode("utf-8")
        s = IMPORT.sub(lambda m: f"{m.group(1)}?v={v}{m.group(2)}", raw)
        s = LINK.sub(lambda m: f"{m.group(1)}?v={v}{m.group(2)}", s)
        s = CONST.sub(lambda m: f"{m.group(1)}{v}{m.group(2)}", s)
        if s != raw:
            open(p, "wb").write(s.encode("utf-8"))
            changed.append(os.path.relpath(p, DOCS))
with open(os.path.join(DOCS, "version.json"), "w", encoding="utf-8", newline="\n") as fh:
    json.dump({"v": v}, fh)
print("version", v, "->", ", ".join(sorted(changed)) or "(no file changed)")
