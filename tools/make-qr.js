// Makes the QR code image files for printing: one per sheet, plus the join code for the projector.
// Usage: node tools/make-qr.js [base URL]   (default https://play.quined.net)
"use strict";
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { load } = require("../lib/content");

const base = (process.argv[2] || process.env.BASE_URL || "https://play.quined.net").replace(/\/$/, "");
const out = path.join(__dirname, "..", "qr");
fs.mkdirSync(out, { recursive: true });
const c = load();
const opts = { margin: 2, errorCorrectionLevel: "M" };

(async () => {
  const rows = [["sheet", "animal", "color", "frame", "url", "png", "svg"]];
  for (const s of c.sheets) {
    const url = `${base}/s/${s.code}`;
    const name = `sheet-${String(s.id).padStart(2, "0")}-${s.animal}`;
    await QRCode.toFile(path.join(out, name + ".png"), url, { ...opts, width: 1200 });
    fs.writeFileSync(path.join(out, name + ".svg"), await QRCode.toString(url, { ...opts, type: "svg" }));
    rows.push([s.id, s.animal, s.color, s.frame, url, name + ".png", name + ".svg"]);
  }
  const joinUrl = base + "/";
  await QRCode.toFile(path.join(out, "join.png"), joinUrl, { ...opts, width: 1200 });
  fs.writeFileSync(path.join(out, "join.svg"), await QRCode.toString(joinUrl, { ...opts, type: "svg" }));
  rows.push(["join", "", "", "", joinUrl, "join.png", "join.svg"]);
  fs.writeFileSync(path.join(out, "qr-codes.csv"), rows.map((r) => r.join(",")).join("\n") + "\n");
  console.log(`Wrote ${c.sheets.length + 1} QR codes (PNG and SVG) to ${out}, for ${base}`);
})();
