// Rough classroom simulation using the real game engine.
// Estimates how often a room reaches the answer, for different class sizes, with and without talking.
// Usage: node tools/simulate.js [trials per setting]
"use strict";
const { load } = require("../lib/content");
const { Game } = require("../lib/game");

const TRIALS = Number(process.argv[2]) || 400;
const c = load();

// ---- assumptions (edit these) -------------------------------------------------
const A = {
  minutes: 15,            // length of a run
  secondsPerScan: 35,     // walk + scan + read, on average
  knowsInTrack: 0.85,     // chance an in-track question is answered right first time (field guide in hand)
  selfDecode: 0.05,       // chance a player decodes another track's term alone (already knows it, looks it up)
  asksWhenTalking: 0.6,   // chance a player holding a strange word asks someone, when talking is allowed
  helperRight: 0.9,       // chance the person asked gives the right answer
  askCostScans: 2,        // time spent finding a helper, in scan-equivalents
  colorTrouble: 0.04,     // share of players who say they have trouble telling colors apart
  settleAfterClues: 3,    // after this many clues, a player may decide they know the answer...
  settleChance: 0.15,     // ...with this chance per scan (premature convergence)
};
// How popular each first choice is ("scan your favorite ..."). Unlisted values get weight 1.
const FAVORITES = {
  animal: { cat: 4, fox: 3, owl: 3, lion: 3, giraffe: 2, zebra: 2, flamingo: 1.5 },
  color: { blue: 5, green: 3, red: 3, purple: 3, yellow: 1.5, brown: 0.5 },
  frame: {},
};
// -------------------------------------------------------------------------------

const rand = Math.random;
function pickWeighted(items, w) {
  const total = items.reduce((s, x) => s + w(x), 0);
  let r = rand() * total;
  for (const x of items) { r -= w(x); if (r <= 0) return x; }
  return items[items.length - 1];
}
const sheetsWith = (cat, val) => c.sheets.filter((s) => s[cat] === val);
const anyOf = (list) => list[Math.floor(rand() * list.length)];

function correctSheetFor(g, p) {
  const t = p.trail;
  if (t.mode === "q") {
    const step = c.trailById.get(t.trail).steps[t.step];
    return anyOf(sheetsWith(p.track, step.answer === "START" ? t.start : step.answer));
  }
  if (t.mode === "hop") { const h = c.routeById.get(t.route).hops[t.hop]; return anyOf(sheetsWith(h.accept.category, h.accept.value)); }
  return null;
}

function simulate(n, talking) {
  const g = new Game(c);
  const players = [];
  for (let i = 0; i < n; i++) players.push({ p: g.join(rand() < A.colorTrouble), busyUntil: 0 });
  g.startRun();
  const steps = Math.floor((A.minutes * 60) / A.secondsPerScan);
  const tracksPresent = new Set(players.map((x) => x.p.track));
  for (let tick = 0; tick < steps; tick++) {
    for (const x of players) {
      const p = x.p;
      if (p.submission || tick < x.busyUntil) continue;
      if (p.trail.mode === "found") { g.submit(p, "chocolate coin"); continue; }
      if (p.notebook.length >= A.settleAfterClues && p.trail.mode === "start" && rand() < A.settleChance) { g.submit(p, "coin"); continue; }
      const t = p.trail;
      let sheet;
      if (t.mode === "start") {
        sheet = p.trailsStarted === 0
          ? pickWeighted(c.sheets, (s) => (FAVORITES[p.track][s[p.track]] || 1))
          : anyOf(c.sheets);
      } else if (t.mode === "qcold") {
        sheet = c.sheetById.get(t.lastSheet);
      } else if (t.mode === "q") {
        sheet = rand() < A.knowsInTrack ? correctSheetFor(g, p) : anyOf(c.sheets);
      } else if (t.mode === "hop") {
        const owner = c.routeById.get(t.route).hops[t.hop].owner;
        if (rand() < A.selfDecode) sheet = correctSheetFor(g, p);
        else if (talking && tracksPresent.has(owner) && rand() < A.asksWhenTalking) {
          x.busyUntil = tick + A.askCostScans;
          sheet = rand() < A.helperRight ? correctSheetFor(g, p) : anyOf(c.sheets);
        } else sheet = anyOf(c.sheets);
      }
      g.scan(p, sheet.code);
    }
  }
  const log = g.log;
  return {
    found: log.filter((e) => e.type === "found").length,
    routes: log.filter((e) => e.type === "hop_shown" && e.detail.hop === 0).length,
    hop2: log.filter((e) => e.type === "hop_shown" && e.detail.hop === 1).length,
    settled: players.filter((x) => x.p.submission && x.p.submission.answer === "coin").length,
  };
}

console.log(`Trials per setting: ${TRIALS}. Run length ${A.minutes} min, about ${Math.floor((A.minutes * 60) / A.secondsPerScan)} scans per player.\n`);
console.log("Players | Talking | Rooms that find it | Finders per room | Routes reached | Reached hop 2 | Settled early");
for (const n of [15, 30, 45]) {
  for (const talking of [false, true]) {
    let any = 0, found = 0, routes = 0, hop2 = 0, settled = 0;
    for (let i = 0; i < TRIALS; i++) {
      const r = simulate(n, talking);
      if (r.found > 0) any++;
      found += r.found; routes += r.routes; hop2 += r.hop2; settled += r.settled;
    }
    const f = (x) => (x / TRIALS).toFixed(1);
    console.log(`${String(n).padStart(7)} | ${talking ? "yes    " : "no     "} | ${String(Math.round((100 * any) / TRIALS)).padStart(17)}% | ${f(found).padStart(16)} | ${f(routes).padStart(14)} | ${f(hop2).padStart(13)} | ${f(settled).padStart(13)}`);
  }
}
