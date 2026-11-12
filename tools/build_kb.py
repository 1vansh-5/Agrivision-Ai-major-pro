"""Turn knowledge.json into docs/kb.js so the website's built-in AI can use it offline.
Edit knowledge.json, then run:  python3 tools/build_kb.py"""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
kb = json.loads((root / "knowledge.json").read_text(encoding="utf-8"))
for e in kb:
    assert {"c", "k", "n", "cure", "prev", "q"} <= e.keys(), f"entry missing fields: {e.get('n')}"
(root / "docs" / "kb.js").write_text("window.AGRI_KB=" + json.dumps(kb, ensure_ascii=False) + ";\n", encoding="utf-8")
print(f"wrote docs/kb.js with {len(kb)} entries")
