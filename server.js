// What's in the box? — web server.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const QRCode = require("qrcode");
const { load, check } = require("./lib/content");
const { Game } = require("./lib/game");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
// Signs the copy of progress each phone keeps, so a restore only accepts copies this server wrote.
const SNAP_SECRET = "witb-snap|" + (process.env.SNAP_SECRET || ADMIN_PASSWORD);

const content = load();
const contentErrors = check(content);
if (contentErrors.length) {
  console.warn("CONTENT PROBLEMS:\n  " + contentErrors.join("\n  "));
} else console.log("Content passes every check.");
if (ADMIN_PASSWORD === "changeme") console.warn("ADMIN_PASSWORD is not set; using 'changeme'.");

// ---------------------------------------------------------------- state, saved to disk when it changes
let saved = null;
try { saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); console.log("Loaded saved game state."); } catch (_) {}
const game = new Game(content, saved);
let lastSaved = 0;
setInterval(() => {
  if (game.changed <= lastSaved) return;
  lastSaved = Date.now();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(game.dumpState()));
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
  } catch (e) { console.warn("Could not save state:", e.message); }
}, 2000);

// ---------------------------------------------------------------- app
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
const pub = path.join(__dirname, "public");
const page = (f) => (req, res) => res.sendFile(path.join(pub, f));

app.get("/", page("player.html"));
app.get("/s/:code", page("player.html"));
app.get("/projector", page("projector.html"));
app.get("/admin", page("admin.html"));
app.use("/static", express.static(pub, { maxAge: "5m" }));
app.get("/healthz", (req, res) => res.json({ ok: true }));

const baseUrl = (req) => BASE_URL || `${req.protocol}://${req.get("host")}`;
app.set("trust proxy", true);

// ---------------------------------------------------------------- player API
function player(req, res) {
  const p = game.auth(req.get("x-player-id"), req.get("x-player-token"));
  if (!p) { res.status(401).json({ error: "unknown player" }); return null; }
  return p;
}
const sign = (data) => crypto.createHmac("sha256", SNAP_SECRET).update(data).digest("hex");
const sealSnap = (snap) => { const data = JSON.stringify(snap); return data + "." + sign(data); };
function openSnap(sealed) {
  if (typeof sealed !== "string") return null;
  const i = sealed.lastIndexOf(".");
  const data = sealed.slice(0, i), sig = Buffer.from(sealed.slice(i + 1));
  const want = Buffer.from(sign(data));
  if (i < 0 || sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  try { return JSON.parse(data); } catch (_) { return null; }
}
const playerReply = (res, p, extra) => {
  const v = game.playerView(p);
  res.json({ ...v, snap: sealSnap(v.snap), ...extra });
};

app.get("/api/intro", (req, res) => {
  const m = content.messages;
  res.json({ opening: m.opening, colorCheck: m.colorCheck });
});

app.post("/api/join", (req, res) => {
  const p = game.join(!!(req.body && req.body.colorTrouble));
  playerReply(res, p, { id: p.id, token: p.token });
});

app.post("/api/restore", (req, res) => {
  const p = game.restore(openSnap(req.body && req.body.snap));
  if (!p) return res.status(400).json({ error: "could not restore" });
  playerReply(res, p);
});

app.get("/api/me", (req, res) => {
  const p = player(req, res); if (!p) return;
  playerReply(res, p);
});

app.get("/api/guide", (req, res) => {
  const p = player(req, res); if (!p) return;
  res.json({
    entries: content.guides[p.track].map((g) => ({ term: g.term, note: g.note })).sort((a, b) => a.term.localeCompare(b.term)),
    mixing: p.track === "color" ? content.colorMixing : null,
  });
});

app.post("/api/scan", (req, res) => {
  const p = player(req, res); if (!p) return;
  game.scan(p, String((req.body && req.body.code) || ""));
  playerReply(res, p);
});

app.post("/api/abandon", (req, res) => {
  const p = player(req, res); if (!p) return;
  game.abandon(p);
  playerReply(res, p);
});

app.post("/api/submit", (req, res) => {
  const p = player(req, res); if (!p) return;
  const r = game.submit(p, req.body && req.body.answer);
  playerReply(res, p, r.error ? { error: r.error } : {});
});

app.get("/api/labels", (req, res) => {
  const m = content.messages;
  res.json({ guideButton: m.guideButton, notebookButton: m.notebookButton, submitButton: m.submitButton,
    submitEntry: m.submitEntry, submitConfirm: m.submitConfirm, abandonButton: m.abandonButton });
});

// ---------------------------------------------------------------- admin API (password in a header, or ?key= for images)
function admin(req, res, next) {
  const key = req.get("x-admin-key") || req.query.key;
  if (key !== ADMIN_PASSWORD) return res.status(401).json({ error: "wrong password" });
  next();
}

app.get("/api/projector", admin, (req, res) => res.json(game.projectorView()));
app.get("/api/admin/state", admin, (req, res) => res.json({ ...game.adminView(), contentErrors, joinUrl: baseUrl(req) + "/" }));
app.post("/api/admin/start", admin, (req, res) => res.json({ ok: game.startRun() }));
app.post("/api/admin/reveal", admin, (req, res) => { game.reveal("instructor"); res.json({ ok: true }); });
app.post("/api/admin/next-run", admin, (req, res) => res.json({ ok: game.nextRun() }));
app.post("/api/admin/score", admin, (req, res) => res.json({ ok: game.setScore(Number(req.body.num), req.body.points) }));
app.post("/api/admin/restore", admin, (req, res) => res.json({ ok: game.restoreGame(Number(req.body.run), req.body.status) }));
app.post("/api/admin/reset", admin, (req, res) => {
  if (!req.body || req.body.confirm !== "RESET") return res.status(400).json({ error: "confirmation missing" });
  game.reset(); game.event(null, "reset"); res.json({ ok: true });
});
app.get("/api/admin/log", admin, (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json({ bootId: game.bootId, events: game.log.filter((e) => e.seq > since) });
});
app.get("/api/admin/export", admin, (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="whats-in-the-box-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json"`);
  res.json({ exportedAt: new Date().toISOString(), bootId: game.bootId, run: game.run, status: game.status,
    players: [...game.players.values()].map((p) => ({ num: p.num, track: p.track, colorTrouble: p.colorTrouble, notebook: p.notebook, submission: p.submission })),
    events: game.log, sheets: content.sheets.map(({ id, animal, color, frame }) => ({ id, animal, color, frame })) });
});
app.get("/api/admin/join-qr.svg", admin, async (req, res) => {
  res.type("image/svg+xml").send(await QRCode.toString(baseUrl(req) + "/", { type: "svg", margin: 1 }));
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
