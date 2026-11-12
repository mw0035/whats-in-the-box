// Game state and rules. No web code here, so it can be tested directly.
"use strict";
const crypto = require("crypto");
const { scoreAnswer, TRACKS, START } = require("./content");

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
const rid = (n = 16) => crypto.randomBytes(n).toString("hex");
const PATH_MAX = 300;
const COLD = ["qcold"];
// The path record leaves out the "Field guide required" line that ends each puzzle.
const shortPuzzle = (q) => String(q || "").replace(/\n\n\*field guide[^\n]*$/i, "");
const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim().slice(0, 30);

class Game {
  constructor(content, saved) {
    this.c = content;
    this.bootId = rid(4);
    this.epoch = 0;
    this.reset();
    // A server that starts without saved state may have lost its place (Render restarts wipe memory).
    // Until a phone or the admin page tells it where things stood, it accepts join codes from a later reset.
    this.fresh = !saved;
    if (saved) this.loadState(saved);
  }

  // A full reset starts a new epoch: phones from an earlier epoch can't restore themselves and must rejoin.
  reset() {
    this.epoch = (this.epoch || 0) + 1;
    this.game = 1;
    this.run = 1;
    this.status = "waiting"; // waiting | playing | revealed
    this.players = new Map();
    this.nextNum = 1;
    this.log = [];
    this.seq = 0;
    this.secret = null; // { num, name, at }: the first player this class to find the secret (the prize is claimed)
    this.changed = Date.now();
  }

  // ---------------------------------------------------------------- persistence
  dumpState() {
    return { epoch: this.epoch, game: this.game, run: this.run, status: this.status, nextNum: this.nextNum, seq: this.seq, log: this.log,
      secret: this.secret, players: [...this.players.values()] };
  }
  loadState(s) {
    this.epoch = s.epoch || 1; this.game = s.game || 1;
    this.run = s.run; this.status = s.status; this.nextNum = s.nextNum; this.seq = s.seq; this.log = s.log || [];
    this.secret = s.secret || null;
    this.players = new Map((s.players || []).map((p) => [p.id, p]));
  }

  event(p, type, sheet, detail) {
    this.log.push({ seq: ++this.seq, t: new Date().toISOString(), boot: this.bootId, game: this.game, run: this.run, player: p ? p.num : null,
      track: p ? p.track : null, type, sheet: sheet || null, detail: detail || null });
    this.changed = Date.now();
  }

  // A join code from a later reset than the server knows about: the server restarted and lost its place.
  adoptEpoch(epoch) {
    if (!Number.isInteger(epoch) || epoch <= this.epoch) return false;
    this.epoch = epoch;
    this.game = 1;
    for (const [id, p] of this.players) if ((p.epoch || 0) < epoch) this.players.delete(id);
    this.event(null, "epoch_adopted", null, { epoch });
    return true;
  }

  // ---------------------------------------------------------------- players
  join(colorTrouble, name) {
    // Fewest players wins; on a tie, Color goes first, because players who opted out of color can't take it.
    const allowed = colorTrouble ? TRACKS.filter((t) => t !== "color") : ["color", ...TRACKS.filter((t) => t !== "color")];
    const count = (t) => [...this.players.values()].filter((p) => p.track === t).length;
    const track = allowed.reduce((best, t) => (count(t) < count(best) ? t : best), allowed[0]);
    const p = {
      id: rid(8), token: rid(16), num: this.nextNum++, name: cleanName(name), track, colorTrouble: !!colorTrouble,
      epoch: this.epoch, game: this.game, run: this.run, hintsLeft: this.hintsPerGame(), hints: [], card: { n: 0 }, notebook: [], finished: [], path: [], trailsStarted: 0, trail: { mode: "start" }, submission: null,
      result: this.c.messages["track_" + track], joinedAt: new Date().toISOString(),
    };
    this.players.set(p.id, p);
    this.fresh = false;
    this.event(p, "join", null, { colorTrouble: !!colorTrouble, name: p.name });
    return p;
  }

  hintsPerGame() {
    const n = this.c.settings && this.c.settings.hintsPerGame;
    return Number.isInteger(n) && n >= 0 ? n : 2;
  }
  displayName(p) { return p.name || `Player ${p.num}`; }

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
      p.streak = [];
      const label = this.c.tracks[p.track].label;
      p.result = fill(this.c.messages.newRun, { r: this.run, track: label, an: /^[aeiou]/i.test(label) ? "n" : "" });
    }
  }

  // Restore a player from the copy their phone kept (used after a server restart).
  restore(snap) {
    if (!snap || typeof snap !== "object" || !snap.id || !snap.token || !TRACKS.includes(snap.track)) return null;
    const existing = this.players.get(snap.id);
    if (existing) return existing.token === snap.token ? existing : null;
    // A copy from before a full reset or an earlier game is stale: the phone starts over.
    const epoch = Number(snap.epoch) || 0, game = Number(snap.game) || 1;
    if (epoch < this.epoch || (epoch === this.epoch && game < this.game)) return null;
    if (epoch > this.epoch) { this.adoptEpoch(epoch); this.game = game; } // the server lost its place
    else if (game > this.game) this.game = game;
    const p = {
      id: String(snap.id), token: String(snap.token), num: Number(snap.num) || this.nextNum, track: snap.track,
      name: cleanName(snap.name), colorTrouble: !!snap.colorTrouble, epoch, game, run: Number(snap.run) || 1,
      hintsLeft: Number.isInteger(snap.hintsLeft) ? Math.max(0, Math.min(snap.hintsLeft, this.hintsPerGame())) : this.hintsPerGame(),
      hints: Array.isArray(snap.hints) ? snap.hints.filter((k) => typeof k === "string").slice(0, 50) : [],
      card: { n: Number(snap.card && snap.card.n) || 0 }, // a restored phone never replays an old card
      foundAnswer: !!snap.foundAnswer,
      secret: snap.secret === "first" || snap.secret === "late" ? snap.secret : null,
      streak: Array.isArray(snap.streak) ? snap.streak.filter((x) => this.c.sheetById.has(x)).slice(-12) : [],
      notebook: Array.isArray(snap.notebook) ? snap.notebook.filter((k) => this.c.clues[k]) : [],
      finished: Array.isArray(snap.finished) ? snap.finished.filter((k) => this.c.trailById.has(k)) : [],
      path: Array.isArray(snap.path) ? snap.path.slice(-PATH_MAX) : [],
      trailsStarted: Number(snap.trailsStarted) || 0, trail: this.validTrail(snap.trail) ? snap.trail : { mode: "start" },
      submission: snap.submission && typeof snap.submission.answer === "string" ? snap.submission : null,
      result: null, joinedAt: snap.joinedAt || new Date().toISOString(),
    };
    this.nextNum = Math.max(this.nextNum, p.num + 1);
    this.players.set(p.id, p);
    // The server lost its memory: a phone that found the secret first tells it the prize is claimed.
    if (p.secret === "first" && !this.secret) this.secret = { num: p.num, name: this.displayName(p), at: null };
    this.event(p, "restore");
    if (p.run > this.run) this.run = p.run; // the server lost its place; a player knows a later run existed
    return p;
  }
  validTrail(t) {
    if (!t || typeof t !== "object") return false;
    if (["start", "found"].includes(t.mode)) return true;
    if (["q", "qcold"].includes(t.mode)) return this.c.trailById.has(t.trail) && Number.isInteger(t.step);
    if (t.mode === "hop") return this.c.routeById.has(t.route) && Number.isInteger(t.hop);
    if (t.mode === "collab") return !!(this.c.routeById.get(t.route) || {}).collab && Number.isInteger(t.hop) && typeof t.code === "string";
    return false;
  }

  // ---------------------------------------------------------------- scanning
  scan(p, code) {
    const sheet = this.c.sheetByCode.get(code);
    if (!sheet) return this.say(p, this.c.messages.scanUnknown);
    if (this.status === "waiting") return p; // keep the track introduction on screen
    if (this.status === "revealed") return this.say(p, this.c.messages.runOver);
    if (p.submission) return this.say(p, this.c.messages.afterSubmitScan);
    const before = p.trail.mode, asked = this.prompt(p), cardBefore = (p.card && p.card.n) || 0;
    this.routeLost = false;
    this.routeDone = false;
    this.trailDone = false;
    this.collabO = null;
    this.scanStep(p, sheet);
    const after = p.trail.mode;
    let o = "fits";
    if (before === "found") o = null;
    else if (before === "collab") o = this.collabO; // null while no collaborator has scanned the code yet
    else if (before === "start") o = this.trailDone ? "done" : "start";
    else if (after === "found" || this.routeDone) o = "found";
    else if (this.routeLost) o = "cold";
    else if (COLD.includes(before)) o = COLD.includes(after) ? "stillCold" : "resume";
    else if (COLD.includes(after)) o = "cold";
    else if (after === "start") o = "clue";
    if (o) this.addPath(p, { s: sheet.id, asked, o });
    this.checkSecret(p, sheet.id, cardBefore);
    return p;
  }

  // The maverick secret: 12 different sheets scanned in a row, within a run. Once per player per game.
  // The first finder in the class is sent to the administrator for the prize; later finders hear it's been claimed.
  checkSecret(p, sheetId, cardBefore) {
    const streak = p.streak || [];
    const i = streak.indexOf(sheetId);
    p.streak = [...(i >= 0 ? streak.slice(i + 1) : streak), sheetId];
    if (p.secret || p.streak.length < this.c.sheets.length) return;
    const m = this.c.messages;
    const first = !this.secret;
    p.secret = first ? "first" : "late";
    if (first) this.secret = { num: p.num, name: this.displayName(p), at: new Date().toISOString() };
    this.event(p, "secret", sheetId, { first });
    const text = first ? m.secretFirst : m.secretClaimed;
    // If this scan already brought up a card (a clue, say), the secret is added to it rather than replacing it.
    if (p.card && p.card.n > cardBefore) p.card = { ...p.card, kind: "secret", text: p.card.text + "\n\n" + text };
    else this.showCard(p, "secret", text);
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
        const trailId = this.c.trailForSheet[p.track][sheet.id];
        if ((p.finished || []).includes(trailId)) {
          // This trail is already done this game: say so instead of starting it again.
          this.trailDone = true;
          this.event(p, "trail_done", sheet.id, { trail: trailId });
          return this.say(p, m.trailDone);
        }
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
        if (trail.outcome.type === "clue") { this.markFinished(p, trail.id); return this.giveClue(p, trail.outcome.clue, sheet.id); }
        if ((p.lostRoutes || []).includes(trail.outcome.route)) {
          // This player already lost this route in this run and retries are off: the trail goes cold.
          p.trail = { mode: "start" };
          this.routeLost = true;
          this.event(p, "route_lost_earlier", sheet.id, { route: trail.outcome.route });
          return this.say(p, m.wrongHop);
        }
        const route = this.c.routeById.get(trail.outcome.route);
        if (route.collab) { this.enterCollab(p, route, 0, sheet.id); return this.say(p, m.correct); }
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
          return this.say(p, this.withNegative(p, m.wrongHop, route.negativeClue, sheet.id));
        }
        this.event(p, "hop_correct", sheet.id, { route: t.route, hop: t.hop });
        if (t.hop + 1 < route.hops.length) {
          p.trail = { mode: "hop", route: t.route, hop: t.hop + 1, lastSheet: sheet.id };
          this.event(p, "hop_shown", sheet.id, { route: t.route, hop: t.hop + 1 });
          return this.say(p, m.correct);
        }
        // A completed cross-track route gives its own high-value clue, if it has one; otherwise the rare clue.
        if (route.clue) {
          // A player may already hold this route's clue (a helper gets copies of others' clues). Then they get another
          // high-value clue they don't have yet, if one is left; only when they have them all is it a repeat.
          let clueId = route.clue;
          if (p.notebook.includes(clueId)) {
            const other = Object.keys(this.c.clues).filter((k) => this.c.clues[k].track === "cross" && !p.notebook.includes(k))
              .sort((a, b) => String(this.c.clues[a].tag).localeCompare(String(this.c.clues[b].tag), undefined, { numeric: true }))[0];
            if (other) clueId = other;
          }
          this.markFinished(p, route.trail);
          this.event(p, "route_clue", sheet.id, { route: t.route, clue: clueId, instead: clueId !== route.clue ? route.clue : undefined });
          return this.giveClue(p, clueId, sheet.id);
        }
        return this.giveRare(p, route, sheet.id);
      }
      case "collab": {
        // A collaboration step: another expert scans this player's code, then this player scans where they point.
        const route = this.c.routeById.get(t.route);
        const hop = route.hops[t.hop];
        const role = this.roleLabel(hop.owner);
        if (!t.helper) return this.say(p, fill(m.collabNotYet, { role }));
        if (sheet[hop.accept.category] !== hop.accept.value) {
          // Retries are allowed, but only with fresh help: the code has to be scanned again.
          p.trail = { ...t, helper: null };
          this.collabO = "collabWrong";
          this.event(p, "hop_wrong", sheet.id, { route: t.route, hop: t.hop, collab: true });
          return this.say(p, fill(m.collabWrong, { role }));
        }
        this.event(p, "hop_correct", sheet.id, { route: t.route, hop: t.hop, collab: true });
        if (t.hop + 1 < route.hops.length) {
          this.collabO = "fits";
          this.enterCollab(p, route, t.hop + 1, sheet.id);
          return this.say(p, m.correct);
        }
        this.collabO = "found";
        return this.giveRare(p, route, sheet.id);
      }
      case "found":
        return this.say(p, m.alreadyFound);
    }
    return this.say(p, null);
  }

  roleLabel(track) { return this.c.tracks[track].label; }

  // The player shows a code that only one other kind of expert can use.
  enterCollab(p, route, hop, sheetId) {
    p.trail = { mode: "collab", route: route.id, hop, lastSheet: sheetId, code: rid(6), helper: null };
    this.event(p, "hop_shown", sheetId, { route: route.id, hop, collab: true });
    this.showCard(p, "collab", fill(this.c.messages.collabCard, { role: this.roleLabel(route.hops[hop].owner) }));
  }

  // The rare clue (messages.found); the player keeps playing.
  giveRare(p, route, sheetId) {
    p.trail = { mode: "start" };
    this.routeDone = true;
    this.event(p, "found", sheetId, { route: route.id });
    this.markFinished(p, route.trail);
    this.showCard(p, "found", this.foundText());
    p.foundAnswer = true; // kept for the rest of this game, so the notebook keeps a record
    return this.say(p, this.foundText());
  }

  // Another player scanned a collaboration code. Only the expert type the route needs can help.
  // The helper sees a pop-up card and keeps their own trail; as thanks they get copies of the other player's clues.
  help(h, code) {
    const m = this.c.messages;
    if (this.status === "waiting") return h;
    if (this.status === "revealed") return this.say(h, m.runOver);
    const a = [...this.players.values()].find((x) => x.trail && x.trail.mode === "collab" && x.trail.code === code);
    if (!a) return this.say(h, m.collabExpired);
    const route = this.c.routeById.get(a.trail.route);
    const hop = route.hops[a.trail.hop];
    if (h.id === a.id || h.track !== hop.owner) {
      this.event(h, "help_wrong_role", null, { for: a.num, route: route.id, hop: a.trail.hop });
      return this.say(h, fill(m.collabWrongRole, { role: this.roleLabel(hop.owner) }));
    }
    a.trail = { ...a.trail, helper: { num: h.num, name: this.displayName(h) } };
    a.result = null;
    // Every notebook clue is shared, high-value ones from word routes included. The rare clue isn't a notebook clue,
    // so it is never shared.
    const gained = a.notebook.filter((k) => !h.notebook.includes(k));
    h.notebook.push(...gained);
    const name = this.displayName(a);
    const tags = gained.map((k) => this.c.clues[k].tag).join(", ");
    const text = fill(m.collabHelperCard, { name, answer: hop.accept.value }) + "\n\n" +
      fill(gained.length ? m.collabReward : m.collabRewardNone, { name, tags });
    this.showCard(h, "help", text);
    this.addPath(h, { s: null, asked: "", o: "helped" });
    this.event(h, "help", null, { for: a.num, route: route.id, hop: a.trail.hop, gained });
    this.changed = Date.now();
    return h;
  }

  // A finished trail (clue found, or cross-track route solved) can't be started again this game.
  markFinished(p, trailId) {
    if (!(p.finished || []).includes(trailId)) p.finished = [...(p.finished || []), trailId];
  }
  // The rare clue's text and its notebook record, with its ID filled in
  foundText() { return fill(this.c.messages.found, { tag: this.c.messages.rareTag || "" }); }
  foundRecordText() { return fill(this.c.messages.foundRecord, { tag: this.c.messages.rareTag || "" }); }

  giveClue(p, clueId, sheetId) {
    const repeat = p.notebook.includes(clueId);
    const clue = this.c.clues[clueId];
    const msg = fill(repeat ? this.c.messages.localOptimumRepeat : this.c.messages.localOptimum, { clue: clue.text, tag: clue.tag || "" });
    if (!repeat) { p.notebook.push(clueId); this.showCard(p, "clue", msg); }
    p.trail = { mode: "start" };
    this.event(p, "clue", sheetId, { clue: clueId, repeat });
    return this.say(p, msg);
  }

  // The phone shows a full-screen card once for each new card number.
  showCard(p, kind, text) {
    p.card = { n: ((p.card && p.card.n) || 0) + 1, kind, text };
  }

  // ---------------------------------------------------------------- hints
  hintKey(t) { return t && (t.mode === "q" || t.mode === "qcold") ? `${t.trail}:${t.step}` : null; }
  currentHint(p) {
    const k = this.hintKey(p.trail);
    return k && (p.hints || []).includes(k) ? this.c.trailById.get(p.trail.trail).steps[p.trail.step].hint : null;
  }
  // "available" | "used" (already shown for this puzzle) | "none" (none left) | "cross" (a cross-track puzzle) | null (no puzzle)
  hintState(p) {
    if (this.status !== "playing" || p.submission) return null;
    if (p.trail.mode === "hop" || p.trail.mode === "collab") return "cross";
    if (p.trail.mode !== "q") return null;
    if ((p.hints || []).includes(this.hintKey(p.trail))) return "used";
    return p.hintsLeft > 0 ? "available" : "none";
  }
  useHint(p) {
    if (this.hintState(p) !== "available") return false;
    const k = this.hintKey(p.trail);
    p.hintsLeft--;
    p.hints = [...(p.hints || []), k];
    this.event(p, "hint", p.trail.lastSheet, { trail: p.trail.trail, step: p.trail.step, left: p.hintsLeft });
    this.addPath(p, { s: null, asked: this.prompt(p), o: "hint" });
    this.changed = Date.now();
    return true;
  }

  abandon(p) {
    if (this.status !== "playing" || p.submission || p.trail.mode === "start" || p.trail.mode === "found") return this.say(p, null);
    const t = p.trail;
    this.event(p, "abandon", null, { from: t });
    this.addPath(p, { s: null, asked: this.prompt(p), o: "abandon" });
    p.trail = { mode: "start" };
    return this.say(p, this.withNegative(p, this.c.messages.abandoned, this.negativeFor(t), t.lastSheet));
  }

  // The negative clue earned by giving up on this trail position, or null. Giving up counts as failing only after
  // at least one correct step: on the trail's own puzzles that earns its lower-tier clue; on a cross-track route
  // (a word step, or a collaboration route after its first step) the route's upper-tier clue.
  negativeFor(t) {
    if (t.mode === "q" || t.mode === "qcold") return t.step >= 1 ? this.c.trailById.get(t.trail).negativeClue : null;
    const route = this.c.routeById.get(t.route);
    if (t.mode === "hop") return route.negativeClue;
    if (t.mode === "collab") return t.hop >= 1 ? route.negativeClue : this.c.trailById.get(route.trail).negativeClue;
    return null;
  }

  // Adds a negative clue to the notebook (once) and to the message. The same failure always gives the same clue.
  withNegative(p, text, clueId, sheetId) {
    if (!clueId || !this.c.clues[clueId]) return text;
    const clue = this.c.clues[clueId];
    const repeat = p.notebook.includes(clueId);
    const msg = fill(repeat ? this.c.messages.negativeRepeat : this.c.messages.negativeClue, { clue: clue.text, tag: clue.tag || "" });
    if (!repeat) { p.notebook.push(clueId); this.showCard(p, "clue", msg); }
    this.event(p, "negative_clue", sheetId || null, { clue: clueId, repeat });
    return text + "\n\n" + msg;
  }

  say(p, result) {
    p.result = result;
    this.changed = Date.now();
    return p;
  }

  // What the phone shows as its main instruction, derived from the player's state.
  // Position of the current puzzle on its trail (cross-track steps continue the count); null when there is no puzzle.
  puzzleNum(p) {
    if (this.status !== "playing" || p.submission) return null;
    const t = p.trail;
    if (t.mode === "q") return t.step + 1;
    if (t.mode === "hop" || t.mode === "collab") {
      const r = this.c.routeById.get(t.route);
      return this.c.trailById.get(r.trail).steps.length + t.hop + 1;
    }
    return null;
  }

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
      case "collab": {
        const role = this.roleLabel(this.c.routeById.get(t.route).hops[t.hop].owner);
        return t.helper ? fill(m.collabHelped, { helper: t.helper.name, role }) : fill(m.collabNeed, { role });
      }
      case "found": return this.foundText();
    }
    return "";
  }

  // ---------------------------------------------------------------- answers
  submit(p, answer) {
    answer = String(answer || "").trim().slice(0, 120);
    if (!answer) return { error: this.c.messages.submitEmpty };
    if (this.status !== "playing") return { error: this.c.messages.submitClosed };
    if (p.submission) return { error: this.c.messages.submitTwice };
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
    // Off by default: the instructor reveals scores from the admin page. Set settings.autoReveal to true to reveal
    // automatically once everyone has submitted and every answer has points.
    if (!(this.c.settings && this.c.settings.autoReveal === true)) return;
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
  // A new game with the same players: notebooks, paths and answers are cleared, and everyone waits for run 1.
  // With newRoles, roles are dealt again (color preference respected, a different role than before where possible).
  newGame(newRoles) {
    this.game++;
    this.run = 1;
    this.status = "waiting";
    const ps = [...this.players.values()];
    const before = new Map(ps.map((p) => [p.id, p.track]));
    if (newRoles) this.dealRoles(ps);
    for (const p of ps) {
      Object.assign(p, { game: this.game, run: 1, notebook: [], finished: [], path: [], trailsStarted: 0, trail: { mode: "start" },
        submission: null, lostRoutes: [], hintsLeft: this.hintsPerGame(), hints: [], foundAnswer: false, secret: null, streak: [] });
      p.result = fill(this.c.messages.newGame, { intro: this.c.messages["track_" + p.track] });
    }
    this.event(null, "new_game", null, { newRoles: !!newRoles,
      changed: ps.filter((p) => p.track !== before.get(p.id)).length, players: ps.length });
    return true;
  }

  // Balanced roles. Players who asked to skip color work are placed first, so they always get a role without color.
  dealRoles(ps) {
    const counts = Object.fromEntries(TRACKS.map((t) => [t, 0]));
    const order = ps.map((p) => ({ p, r: Math.random() })).sort((a, b) => (b.p.colorTrouble - a.p.colorTrouble) || (a.r - b.r)).map((x) => x.p);
    const cap = Math.ceil(ps.length / TRACKS.length);
    for (const p of order) {
      const allowed = p.colorTrouble ? TRACKS.filter((t) => t !== "color") : TRACKS;
      const fewest = Math.min(...allowed.map((t) => counts[t]));
      const underCap = allowed.filter((t) => counts[t] < cap);
      const open = underCap.length ? underCap : allowed.filter((t) => counts[t] === fewest);
      const fresh = open.filter((t) => t !== p.track);
      const pool = fresh.length ? fresh : open;
      p.track = pool[Math.floor(Math.random() * pool.length)];
      counts[p.track]++;
    }
  }

  restoreGame(run, status, epoch, game) {
    if (!Number.isInteger(run) || run < 1 || !["waiting", "playing", "revealed"].includes(status)) return false;
    this.fresh = false;
    if (Number.isInteger(epoch) && epoch > this.epoch) this.adoptEpoch(epoch);
    if (Number.isInteger(game) && epoch === this.epoch && game > this.game) this.game = game;
    this.run = Math.max(this.run, run);
    this.status = status;
    this.event(null, "game_restore", null, { run, status, epoch, game });
    return true;
  }

  // ---------------------------------------------------------------- views
  playerView(p) {
    const c = this.c;
    return {
      num: p.num, name: this.displayName(p), track: p.track, trackLabel: c.tracks[p.track].label, run: this.run, status: this.status,
      result: p.result, prompt: this.prompt(p), puzzleNum: this.puzzleNum(p),
      hint: this.currentHint(p), hintState: this.hintState(p), hintsLeft: p.hintsLeft, hintsTotal: this.hintsPerGame(),
      card: p.card && p.card.n ? { n: p.card.n, kind: p.card.kind, text: p.card.text } : null,
      helpCode: this.status === "playing" && !p.submission && p.trail.mode === "collab" ? p.trail.code : null,
      canScan: this.status === "playing" && !p.submission,
      canAbandon: this.status === "playing" && !p.submission && !["start", "found"].includes(p.trail.mode),
      submission: p.submission ? { answer: p.submission.answer } : null,
      notebook: p.notebook.map((k) => fill(c.messages.notebookEntry || "{clue}", { tag: c.clues[k].tag || "", clue: c.clues[k].text })),
      foundNote: p.foundAnswer ? this.foundRecordText() : null,
      secretNote: p.secret === "first" ? this.c.messages.secretRecord : p.secret === "late" ? this.c.messages.secretRecordClaimed : null,
      path: (p.path || []).map((x) => ({ run: x.run, o: x.o, place: x.s ? this.place(x.s) : "", asked: shortPuzzle(x.asked),
        what: x.o === "found" ? this.foundRecordText() : c.messages["path" + x.o[0].toUpperCase() + x.o.slice(1)] || x.o })),
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
      // [key, count, label]: the label is the editable wording shown on the projector
      view.distribution = Object.entries(dist).sort((a, b) => (Number(b[0]) || -1) - (Number(a[0]) || -1)).map(([key, n]) =>
        [key, n, key === "No answer" ? m.projectorNoAnswer : key === "Not scored" ? m.projectorNotScored : fill(m.projectorPoints, { points: key })]);
    }
    return view;
  }

  adminView() {
    const ps = [...this.players.values()];
    const cur = this.current();
    const runLog = this.log.filter((e) => e.run === this.run && (e.game || 1) === this.game);
    const n = (type) => runLog.filter((e) => e.type === type).length;
    const byTrack = {};
    for (const t of TRACKS) byTrack[t] = cur.filter((p) => p.track === t).length;
    return {
      bootId: this.bootId, epoch: this.epoch, game: this.game, run: this.run, status: this.status, ...this.counts(), byTrack, totalPlayers: ps.length,
      stats: {
        scans: n("scan"), clues: n("clue"),
        routesReached: runLog.filter((e) => e.type === "hop_shown" && e.detail.hop === 0).length,
        hopCorrect: n("hop_correct"), hopWrong: n("hop_wrong"), found: n("found"), hints: n("hint"), helps: n("help"),
      },
      submissions: cur.filter((p) => p.submission).map((p) => ({
        num: p.num, name: this.displayName(p), track: p.track, answer: p.submission.answer, points: p.submission.points, label: p.submission.label, auto: p.submission.auto,
      })).sort((a, b) => a.num - b.num),
      logSize: this.log.length,
      secret: this.secret,
    };
  }
}

module.exports = { Game, fill };
