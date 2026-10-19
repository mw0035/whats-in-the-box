"""Reads app/content.json and exposes the names the workbook builder expects."""
import json, os
_c = json.load(open(os.path.join(os.path.dirname(__file__), "..", "content.json")))
TRACKS = ["animal", "color", "frame"]
TRACK_LABEL = {t: _c["tracks"][t]["label"] for t in TRACKS}
COLORS, FRAMES, ANIMALS = _c["colors"], _c["frames"], _c["animals"]
SHEETS = [{"id": s["id"], "animal": s["animal"], "color": s["color"], "frame": s["frame"]} for s in _c["sheets"]]
CANDIDATES = _c["candidates"]
CLUES = {k: {"track": v["track"], "text": v["text"], "fits": v["fits"]} for k, v in _c["clues"].items()}
SUGGESTS = {k: v["suggests"] for k, v in _c["clues"].items()}
START = "START"
FAMILIES = [{"id": t["id"], "track": t["track"], "starts": t["starts"],
             "steps": [(s["question"], s["answer"]) for s in t["steps"]],
             "outcome": ("clue", t["outcome"]["clue"]) if t["outcome"]["type"] == "clue" else ("route", t["outcome"]["route"])}
            for t in _c["trails"]]
ROUTES = [{"id": r["id"], "family": r["trail"], "receiver": r["track"],
           "hops": [{"term": h["term"], "owner": h["owner"], "accept": (h["accept"]["category"], h["accept"]["value"]),
                     "fallback": (h["fallback"]["question"], h["fallback"]["answer"], h["fallback"]["clue"])} for h in r["hops"]]}
          for r in _c["routes"]]
ANSWER = _c["messages"]["found"]
GUIDES = {t: [(g["term"], g["value"], g["note"]) for g in _c["guides"][t]] for t in TRACKS}
COLOR_MIXING = _c["colorMixing"]
MESSAGES = [(_c.get("messageLabels", {}).get(k, k), v) for k, v in _c["messages"].items()]
def _rule(r):
    parts = []
    for cl in r["when"]:
        s = "any of: " + ", ".join(cl["any"])
        if cl.get("andAny"): s += "  AND any of: " + ", ".join(cl["andAny"])
        parts.append(s)
    return "  OR  ".join(parts)
SCORING = [(r["points"], r["label"], _rule(r), []) for r in _c["scoring"]] + [(0, "Unrecognized", "anything else: flagged on the admin page to score by hand", [])]
MONEY_WORDS = []
def image_prompt(s):
    return (f"Flat illustration of a single {s['color']} {s['animal']}, simple silhouette, centered, "
            f"inside a thick black {s['frame']}-shaped frame outline. White background, no text, "
            f"no other objects. Colors must be clearly {s['color']} when printed.")
