// Loads content.json, builds lookups, scores answers, and checks the content's rules.
"use strict";
const fs = require("fs");
const path = require("path");

const CONTENT_PATH = process.env.CONTENT_PATH || path.join(__dirname, "..", "content.json");
const TRACKS = ["animal", "color", "frame"];
const START = "START";

function load(file = CONTENT_PATH) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.sheetById = new Map(c.sheets.map((s) => [s.id, s]));
  c.sheetByCode = new Map(c.sheets.map((s) => [s.code, s]));
  c.trailById = new Map(c.trails.map((t) => [t.id, t]));
  c.routeById = new Map(c.routes.map((r) => [r.id, r]));
  c.trailForStart = {};
  for (const t of c.trails) {
    c.trailForStart[t.track] = c.trailForStart[t.track] || {};
    for (const v of t.starts) c.trailForStart[t.track][v] = t.id;
  }
  return c;
}

// ---------------------------------------------------------------- scoring
function words(text) {
  return String(text || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// a word matches a keyword exactly, or with one typo for keywords of 5+ letters (two for 8+)
function wordMatches(w, k) {
  if (w === k) return true;
  if (k.length >= 8) return lev(w, k) <= 2;
  if (k.length >= 5) return lev(w, k) <= 1;
  return false;
}
function hasAny(ws, list) {
  return ws.some((w) => list.some((k) => wordMatches(w, k)));
}
// Returns { points, label } or { points: null, label: "Unrecognized" }
function scoreAnswer(content, answer) {
  const ws = words(answer);
  for (const rule of content.scoring) {
    for (const clause of rule.when) {
      if (hasAny(ws, clause.any) && (!clause.andAny || hasAny(ws, clause.andAny)))
        return { points: rule.points, label: rule.label };
    }
  }
  return { points: null, label: "Unrecognized" };
}

// ---------------------------------------------------------------- checks
const FORBIDDEN = ["chocolate", "candy", "candies", "sweet", "sugar", "cocoa", "cacao", "edible", "eat", "eaten", "melt",
  "melts", "treat", "treats", "dessert", "snack", "foil", "wrapped", "wrapper", "gelt", "hanukkah", "taste", "tasty",
  "delicious", "bite", "lick", "yum", "grandparent", "grandparents", "halloween", "trick"];

function check(c) {
  const errs = [];
  const vals = { animal: new Set(c.animals), color: new Set(c.colors), frame: new Set(c.frames) };
  const ids = (cat, val) => new Set(c.sheets.filter((s) => s[cat] === val).map((s) => s.id));
  const gterms = {};
  for (const t of TRACKS) gterms[t] = new Map(c.guides[t].map((g) => [g.term.toLowerCase(), g.value]));
  const findTerm = (t, term) => [...gterms[t].keys()].find((k) => k === term || k.startsWith(term + " "));

  // sheets
  const codes = new Set();
  for (const s of c.sheets) {
    for (const t of TRACKS) if (!vals[t].has(s[t])) errs.push(`Sheet #${s.id}: unknown ${t} "${s[t]}"`);
    if (codes.has(s.code)) errs.push(`Sheet #${s.id}: duplicate QR code`);
    codes.add(s.code);
  }
  const animalsUsed = c.sheets.map((s) => s.animal);
  if (new Set(animalsUsed).size !== animalsUsed.length) errs.push("Two sheets have the same animal");
  const pairs = c.sheets.map((s) => s.color + "|" + s.frame);
  if (new Set(pairs).size !== pairs.length) errs.push("Two sheets share the same color and frame");
  for (const t of ["color", "frame"]) for (const v of vals[t]) if (ids(t, v).size === 0) errs.push(`No sheet has ${t} "${v}"`);

  // trails
  for (const t of TRACKS) {
    const starts = c.trails.filter((x) => x.track === t).flatMap((x) => x.starts);
    const missing = [...vals[t]].filter((v) => !starts.includes(v));
    const dup = starts.filter((v, i) => starts.indexOf(v) !== i);
    if (missing.length) errs.push(`${t}: no trail starts from ${missing.join(", ")}`);
    if (dup.length) errs.push(`${t}: more than one trail starts from ${dup.join(", ")}`);
  }
  const resolve = (a, st) => (a === START ? st : a);
  for (const f of c.trails) {
    if (f.steps.length < 1) errs.push(`Trail ${f.id}: no questions`);
    for (const [i, s] of f.steps.entries()) if (!s.hint || !String(s.hint).trim()) errs.push(`Trail ${f.id}: question ${i + 1} has no hint`);
    for (const s of f.steps) if (s.answer !== START && !vals[f.track].has(s.answer)) errs.push(`Trail ${f.id}: answer "${s.answer}" is not on any sheet`);
    for (const st of f.starts) {
      let prev = st;
      for (const [i, s] of f.steps.entries()) {
        const a = resolve(s.answer, st);
        if (a === prev) errs.push(`Trail ${f.id}: question ${i + 1} is answered by the sheet the player is already on (start ${st})`);
        prev = a;
      }
    }
    if (f.outcome.type === "clue") {
      if (!c.clues[f.outcome.clue]) errs.push(`Trail ${f.id}: unknown clue ${f.outcome.clue}`);
      else if (c.clues[f.outcome.clue].track !== f.track) errs.push(`Trail ${f.id}: clue from another track`);
    } else if (!c.routeById.has(f.outcome.route)) errs.push(`Trail ${f.id}: unknown route ${f.outcome.route}`);
  }

  // routes
  for (const r of c.routes) {
    const fam = c.trailById.get(r.trail);
    if (!fam || fam.outcome.type !== "route" || fam.outcome.route !== r.id || fam.track !== r.track) {
      errs.push(`Route ${r.id}: doesn't match trail ${r.trail}`);
      continue;
    }
    const owners = r.hops.map((h) => h.owner);
    if (owners.includes(r.track)) errs.push(`Route ${r.id}: a hop uses the player's own track`);
    if (new Set(owners).size !== owners.length) errs.push(`Route ${r.id}: two hops use the same track`);
    for (const st of fam.starts) {
      let here = ids(r.track, resolve(fam.steps[fam.steps.length - 1].answer, st));
      for (const [k, h] of r.hops.entries()) {
        const acc = ids(h.accept.category, h.accept.value);
        const overlap = [...here].filter((x) => acc.has(x));
        if (overlap.length) errs.push(`Route ${r.id} hop ${k + 1}: answerable by rescanning sheet #${overlap.join(", #")}`);
        here = acc;
      }
    }
    for (const [k, h] of r.hops.entries()) {
      const term = h.term.toLowerCase();
      const hit = findTerm(h.owner, term);
      if (!hit) errs.push(`Route ${r.id} hop ${k + 1}: "${h.term}" isn't in the ${h.owner} field guide`);
      else if (gterms[h.owner].get(hit) !== h.accept.value) errs.push(`Route ${r.id} hop ${k + 1}: the ${h.owner} guide maps "${h.term}" to something else`);
      if (h.accept.category !== h.owner) errs.push(`Route ${r.id} hop ${k + 1}: answer category should be ${h.owner}`);
      if (!vals[h.accept.category] || !vals[h.accept.category].has(h.accept.value)) errs.push(`Route ${r.id} hop ${k + 1}: answer "${h.accept.value}" isn't on any sheet`);
      for (const t of TRACKS) if (t !== h.owner && [...gterms[t].keys()].some((x) => x === term || x.startsWith(term))) errs.push(`Route ${r.id}: "${h.term}" also appears in the ${t} guide`);
    }
  }

  // guides: every printed value in a guide exists
  for (const t of TRACKS) for (const g of c.guides[t]) if (g.value && !vals[t].has(g.value)) errs.push(`${t} guide: "${g.term}" points to "${g.value}", which isn't on any sheet`);

  // clue logic
  for (const [k, cl] of Object.entries(c.clues)) {
    if (!cl.fits[c.candidates[c.candidates.length - 1]]) errs.push(`Clue ${k} isn't true of the answer`);
  }

  // no hint toward the answer anywhere a player can see before completing a route
  const visible = [];
  for (const cl of Object.values(c.clues)) visible.push(cl.text);
  for (const f of c.trails) for (const s of f.steps) visible.push(s.question, s.hint || "");
  for (const r of c.routes) for (const h of r.hops) visible.push(h.term);
  for (const t of TRACKS) for (const g of c.guides[t]) visible.push(g.term + " " + g.note);
  for (const [k, m] of Object.entries(c.messages)) if (k !== "found" && k !== "foundRecord") visible.push(m);
  for (const s of c.sheets) visible.push(`${s.animal} ${s.color} ${s.frame}`);
  for (const text of visible) {
    const bad = words(text).filter((w) => FORBIDDEN.includes(w));
    if (bad.length) errs.push(`Hint toward the answer ("${[...new Set(bad)].join(", ")}") in: ${text}`);
  }
  return errs;
}

module.exports = { load, check, scoreAnswer, TRACKS, START, CONTENT_PATH };

if (require.main === module) {
  const c = load(process.argv[2] || CONTENT_PATH);
  const errs = check(c);
  console.log(errs.length ? errs.join("\n") : "OK: content passes every check");
  process.exit(errs.length ? 1 : 0);
}
