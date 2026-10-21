// Game state and rules. No web code here, so it can be tested directly.
"use strict";
const crypto = require("crypto");
const { scoreAnswer, TRACKS, START } = require("./content");

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
const rid = (n = 16) => crypto.randomBytes(n).toString("hex");
const PATH_MAX = 300;
const COLD = ["qcold"];

class Game {
  constructor(content, saved) {
    this.c = content;
    this.bootId = rid(4);
    this.reset();
    if (saved) this.loadState(saved);
  }

  reset() {
    this.run = 1;
    this.status = "waiting"; // waiting | playing | revealed
    this.players = new Map();
    this.nextNum = 1;
    this.log = [];
    this.seq = 0;
    this.changed = Date.now();
  }

  // ---------------------------------------------------------------- persistence
  dumpState() {
    return { run: this.run, status: this.status, nextNum: this.nextNum, seq: this.seq, log: this.log, players: [...this.players.values()] };
  }
  loadState(s) {
    this.run = s.run; this.status = s.status; this.nextNum = s.nextNum; this.seq = s.seq; this.log = s.log || [];
    this.players = new Map((s.players || []).map((p) => [p.id, p]));
  }

  event(p, type, sheet, detail) {
    this.log.push({ seq: ++this.seq, t: new Date().toISOString(), boot: this.bootId, run: this.run, player: p ? p.num : null,
      track: p ? p.track : null, type, sheet: sheet || null, detail: detail || null });
    this.changed = Date.now();
  }

  // ---------------------------------------------------------------- players
  join(colorTrouble) {
    const allowed = colorTrouble ? TRACKS.filter((t) => t !== "color") : TRACKS;
    const count = (t) => [...this.players.values()].filter((p) => p.track === t).length;
    const track = allowed.reduce((best, t) => (count(t) < count(best) ? t : best), allowed[0]);
    const p = {
      id: rid(8), token: rid(16), num: this.nextNum++, track, colorTrouble: !!colorTrouble,
      run: this.run, notebook: [], path: [], trailsStarted: 0, trail: { mode: "start" }, submission: null,
      result: this.c.messages["track_" + track], joinedAt: new Date().toISOString(),
    };
    this.players.set(p.id, p);
    this.event(p, "join", null, { colorTrouble: !!colorTrouble });
    return p;
  }

  auth(id, token) {
    const p = this.players.get(id);
    if (!p || p.token !== token) return null;
    this.syncRun(p);
    return p;
  }

  // Bring a player into the current run (new runs reset trails and submissions, keep track and notebook).
  syncRun(p) {
    if (p.run < this.run) {
      p.run = this.run;
      p.trail = { mode: "start" };
      p.submission = null;
      p.lostRoutes = [];
      const label = this.c.tracks[p.track].label;
      p.result = fill(this.c.messages.newRun, { r: this.run, track: label, an: /^[aeiou]/i.test(label) ? "n" : "" });
    }
  }

  // Restore a player from the copy their phone kept (used after a server restart).
  restore(snap) {
    if (!snap || typeof snap !== "object" || !snap.id || !snap.token || !TRACKS.includes(snap.track)) return null;
    const existing = this.players.get(snap.id);
    if (existing) return existing.token === snap.token ? existing : null;
    const p = {
      id: String(snap.id), token: String(snap.token), num: Number(snap.num) || this.nextNum, track: snap.track,
      colorTrouble: !!snap.colorTrouble, run: Number(snap.run) || 1,
      notebook: Array.isArray(snap.notebook) ? snap.notebook.filter((k) => this.c.clues[k]) : [],
      path: Array.isArray(snap.path) ? snap.path.slice(-PATH_MAX) : [],
      trailsStarted: Number(snap.trailsStarted) || 0, trail: this.validTrail(snap.trail) ? snap.trail : { mode: "start" },
      submission: snap.submission && typeof snap.submission.answer === "string" ? snap.submission : null,
      result: null, joinedAt: snap.joinedAt || new Date().toISOString(),
    };
    this.nextNum = Math.max(this.nextNum, p.num + 1);
    this.players.set(p.id, p);
    this.event(p, "restore");
    if (p.run > this.run) this.run = p.run; // the server lost its place; a player knows a later run existed
    return p;
  }
  validTrail(t) {
    if (!t || typeof t !== "object") return false;
    if (["start", "found"].includes(t.mode)) return true;
    if (["q", "qcold"].includes(t.mode)) return this.c.trailById.has(t.trail) && Number.isInteger(t.step);
    if (t.mode === "hop") return this.c.routeById.has(t.route) && Number.isInteger(t.hop);
    return false;
  }

  // ---------------------------------------------------------------- scanning
  scan(p, code) {
    const sheet = this.c.sheetByCode.get(code);
    if (!sheet) return this.say(p, this.c.messages.scanUnknown);
    if (this.status === "waiting") return p; // keep the track introduction on screen
    if (this.status === "revealed") return this.say(p, this.c.messages.runOver);
    if (p.submission) return this.say(p, this.c.messages.afterSubmitScan);
    const before = p.trail.mode, asked = this.prompt(p);
    this.routeLost = false;
    this.scanStep(p, sheet);
    const after = p.trail.mode;
    let o = "fits";
    if (before === "found") o = null;
    else if (before === "start") o = "start";
    else if (after === "found") o = "found";
    else if (this.routeLost) o = "cold";
    else if (COLD.includes(before)) o = COLD.includes(after) ? "stillCold" : "resume";
    else if (COLD.includes(after)) o = "cold";
    else if (after === "start") o = "clue";
    if (o) this.addPath(p, { s: sheet.id, asked, o });
    return p;
  }

  addPath(p, step) {
    p.path = [...(p.path || []), { run: this.run, ...step }].slice(-PATH_MAX);
  }

  // How a spot in the room is described to players, e.g. "red owl in the diamond"
  place(sheetId) {
    const s = this.c.sheetById.get(sheetId);
    return s ? fill(this.c.messages.place, s) : "";
  }

  scanStep(p, sheet) {
    this.event(p, "scan", sheet.id);
    const t = p.trail;
    const mine = sheet[p.track];
    const m = this.c.messages;

    switch (t.mode) {
      case "start": {
        const trailId = this.c.trailForStart[p.track][mine];
        p.trailsStarted++;
        p.trail = { mode: "q", trail: trailId, step: 0, start: mine, lastSheet: sheet.id };
        this.event(p, "trail_start", sheet.id, { trail: trailId });
        return this.say(p, null);
      }
      case "q": {
        const trail = this.c.trailById.get(t.trail);
        const step = trail.steps[t.step];
        const want = step.answer === START ? t.start : step.answer;
        if (mine !== want) {
          p.trail = { ...t, mode: "qcold" };
          this.event(p, "wrong", sheet.id, { trail: t.trail, step: t.step });
          return this.say(p, null);
        }
        this.event(p, "correct", sheet.id, { trail: t.trail, step: t.step });
        if (t.step + 1 < trail.steps.length) {
          p.trail = { ...t, step: t.step + 1, lastSheet: sheet.id };
          return this.say(p, m.correct);
        }
        if (trail.outcome.type === "clue") return this.giveClue(p, trail.outcome.clue, sheet.id);
        if ((p.lostRoutes || []).includes(trail.outcome.route)) {
          // This player already lost this route in this run and retries are off: the trail goes cold.
          p.trail = { mode: "start" };
          this.routeLost = true;
          this.event(p, "route_lost_earlier", sheet.id, { route: trail.outcome.route });
          return this.say(p, m.wrongHop);
        }
        p.trail = { mode: "hop", route: trail.outcome.route, hop: 0, lastSheet: sheet.id };
        this.event(p, "hop_shown", sheet.id, { route: trail.outcome.route, hop: 0 });
        return this.say(p, m.correct);
      }
      case "qcold": {
        if (sheet.id !== t.lastSheet) return this.say(p, m.coldRepeat);
        p.trail = { ...t, mode: "q" };
        return this.say(p, null);
      }
      case "hop": {
        const route = this.c.routeById.get(t.route);
        const hop = route.hops[t.hop];
        if (sheet[hop.accept.category] !== hop.accept.value) {
          // One shot per cross-track step: a wrong scan ends the trail.
          p.trail = { mode: "start" };
          this.routeLost = true;
          if (this.c.settings && this.c.settings.retryLostRoutes === false) p.lostRoutes = [...(p.lostRoutes || []), t.route];
          this.event(p, "hop_wrong", sheet.id, { route: t.route, hop: t.hop });
          return this.say(p, m.wrongHop);
        }
        this.event(p, "hop_correct", sheet.id, { route: t.route, hop: t.hop });
        if (t.hop + 1 < route.hops.length) {
          p.trail = { mode: "hop", route: t.route, hop: t.hop + 1, lastSheet: sheet.id };
          this.event(p, "hop_shown", sheet.id, { route: t.route, hop: t.hop + 1 });
          return this.say(p, m.correct);
        }
        p.trail = { mode: "found" };
        this.event(p, "found", sheet.id, { route: t.route });
        return this.say(p, null);
      }
      case "found":
        return this.say(p, m.alreadyFound);
    }
    return this.say(p, null);
  }

  giveClue(p, clueId, sheetId) {
    const repeat = p.notebook.includes(clueId);
    if (!repeat) p.notebook.push(clueId);
    p.trail = { mode: "start" };
    this.event(p, "clue", sheetId, { clue: clueId, repeat });
    const msg = repeat ? this.c.messages.localOptimumRepeat : this.c.messages.localOptimum;
    return this.say(p, fill(msg, { clue: this.c.clues[clueId].text }));
  }

  abandon(p) {
    if (this.status !== "playing" || p.submission || p.trail.mode === "start" || p.trail.mode === "found") return this.say(p, null);
    this.event(p, "abandon", null, { from: p.trail });
    this.addPath(p, { s: null, asked: this.prompt(p), o: "abandon" });
    p.trail = { mode: "start" };
    return this.say(p, this.c.messages.abandoned);
  }

  say(p, result) {
    p.result = result;
    this.changed = Date.now();
    return p;
  }

  // What the phone shows as its main instruction, derived from the player's state.
  prompt(p) {
    const m = this.c.messages, t = p.trail;
    if (this.status === "waiting") return m.notStarted;
    if (this.status === "revealed") {
      if (!p.submission) return m.noSubmission;
      if (p.submission.points == null) return fill(m.notScored, { answer: p.submission.answer });
      return fill(m.revealPhone, { answer: p.submission.answer, score: p.submission.points });
    }
    if (p.submission) return m.afterSubmit;
    switch (t.mode) {
      case "start": return p.trailsStarted === 0 && this.run === 1 ? m["firstPrompt_" + p.track] : m.newTrail;
      case "q": return this.c.trailById.get(t.trail).steps[t.step].question;
      case "qcold": return fill(m.wrongInTrack, { place: this.place(t.lastSheet) });
      case "hop": return fill(m.hop, { term: this.c.routeById.get(t.route).hops[t.hop].term });
      case "found": return m.found;
    }
    return "";
  }

  // ---------------------------------------------------------------- answers
  submit(p, answer) {
    answer = String(answer || "").trim().slice(0, 120);
    if (!answer) return { error: "Type an answer first." };
    if (this.status !== "playing") return { error: this.c.messages.submitClosed };
    if (p.submission) return { error: "You've already submitted an answer this run." };
    const s = scoreAnswer(this.c, answer);
    p.submission = { answer, points: s.points, label: s.label, auto: s.points != null, at: new Date().toISOString() };
    p.result = null;
    this.event(p, "submit", null, { answer, points: s.points, label: s.label });
    this.maybeReveal();
    return { ok: true };
  }

  current() { return [...this.players.values()].filter((p) => p.run === this.run || p.run > this.run); }

  counts() {
    const ps = this.current();
    const submitted = ps.filter((p) => p.submission);
    return { players: ps.length, submitted: submitted.length, unscored: submitted.filter((p) => p.submission.points == null).length };
  }

  maybeReveal() {
    const k = this.counts();
    if (this.status === "playing" && k.players > 0 && k.submitted === k.players && k.unscored === 0) this.reveal("auto");
  }

  reveal(how) {
    if (this.status !== "playing") return;
    this.status = "revealed";
    this.event(null, "reveal", null, { how, ...this.counts() });
  }

  setScore(num, points) {
    const p = [...this.players.values()].find((x) => x.num === num);
    if (!p || !p.submission) return false;
    p.submission.points = points === null || points === "" ? null : Math.max(0, Math.min(100, Number(points)));
    p.submission.auto = false;
    this.event(p, "hand_score", null, { points: p.submission.points });
    this.maybeReveal();
    return true;
  }

  // ---------------------------------------------------------------- runs
  startRun() {
    if (this.status === "waiting") { this.status = "playing"; this.event(null, "run_start"); return true; }
    return false;
  }
  nextRun() {
    if (this.status !== "revealed") return false;
    this.run++;
    this.status = "playing";
    for (const p of this.players.values()) this.syncRun(p);
    this.event(null, "run_start");
    return true;
  }
  restoreGame(run, status) {
    if (!Number.isInteger(run) || run < 1 || !["waiting", "playing", "revealed"].includes(status)) return false;
    this.run = Math.max(this.run, run);
    this.status = status;
    this.event(null, "game_restore", null, { run, status });
    return true;
  }

  // ---------------------------------------------------------------- views
  playerView(p) {
    const c = this.c;
    return {
      num: p.num, track: p.track, trackLabel: c.tracks[p.track].label, run: this.run, status: this.status,
      result: p.result, prompt: this.prompt(p),
      canScan: this.status === "playing" && !p.submission,
      canAbandon: this.status === "playing" && !p.submission && !["start", "found"].includes(p.trail.mode),
      submission: p.submission ? { answer: p.submission.answer } : null,
      notebook: p.notebook.map((k) => c.clues[k].text),
      path: (p.path || []).map((x) => ({ run: x.run, o: x.o, place: x.s ? this.place(x.s) : "", asked: x.asked,
        what: c.messages["path" + x.o[0].toUpperCase() + x.o.slice(1)] || x.o })),
      snap: p,
    };
  }

  projectorView() {
    const k = this.counts();
    const m = this.c.messages;
    const view = { run: this.run, status: this.status, ...k, opening: m.opening, waitingText: m.projectorWaiting,
      countText: fill(m.projectorCount, { r: this.run, k: k.submitted, n: k.players }), revealTitle: fill(m.revealProjector, { r: this.run }) };
    if (this.status === "revealed") {
      const dist = {};
      for (const p of this.current()) {
        const key = !p.submission ? "No answer" : p.submission.points == null ? "Not scored" : String(p.submission.points);
        dist[key] = (dist[key] || 0) + 1;
      }
      view.distribution = Object.entries(dist).sort((a, b) => (Number(b[0]) || -1) - (Number(a[0]) || -1));
    }
    return view;
  }

  adminView() {
    const ps = [...this.players.values()];
    const cur = this.current();
    const runLog = this.log.filter((e) => e.run === this.run);
    const n = (type) => runLog.filter((e) => e.type === type).length;
    const byTrack = {};
    for (const t of TRACKS) byTrack[t] = cur.filter((p) => p.track === t).length;
    return {
      bootId: this.bootId, run: this.run, status: this.status, ...this.counts(), byTrack, totalPlayers: ps.length,
      stats: {
        scans: n("scan"), clues: n("clue"),
        routesReached: runLog.filter((e) => e.type === "hop_shown" && e.detail.hop === 0).length,
        hopCorrect: n("hop_correct"), hopWrong: n("hop_wrong"), found: n("found"),
      },
      submissions: cur.filter((p) => p.submission).map((p) => ({
        num: p.num, track: p.track, answer: p.submission.answer, points: p.submission.points, label: p.submission.label, auto: p.submission.auto,
      })).sort((a, b) => a.num - b.num),
      logSize: this.log.length,
    };
  }
}

module.exports = { Game, fill };
