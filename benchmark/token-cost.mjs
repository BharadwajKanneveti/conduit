#!/usr/bin/env node
// Measures the per-request token cost of a real MCP tool catalog: the tool
// definitions an agent loads into context on every request without lazy
// discovery, broken down by server, plus the savings from Toolport's
// lazy mode and what it means in context window, dollars, and scaling.
//
// Usage:
//   node token-cost.mjs [path-to-tool-cache.json] [lazyFloorTokens]
//
// With no path it auto-resolves the active profile's cache in Toolport's data dir
// (Windows %APPDATA%\Conduit, macOS ~/Library/Application Support/Conduit,
// Linux ~/.config/Conduit). The cache is the aggregated catalog Toolport builds
// (an array of tool objects with namespaced `server__tool` names). The token
// estimate mirrors the gateway's own: serialized JSON length / 4.

import { readFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Toolport's data dir, matching the gateway's registry::conduit_dir().
function conduitDir() {
  if (platform() === "win32") return join(homedir(), "AppData", "Roaming", "Conduit");
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "Conduit");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Conduit");
}

// Resolve the cache file: explicit arg, else the active profile's tool-cache.json.
function resolveCachePath(arg) {
  if (arg) return arg;
  const def = join(conduitDir(), "tool-cache.json");
  if (existsSync(def)) return def;
  console.error(
    `No cache path given and none found at:\n  ${def}\n\n` +
      `The gateway writes this file when a client connects (a profile-scoped client\n` +
      `writes tool-cache-<profile>.json instead). Connect a client once, or pass the\n` +
      `path explicitly: node token-cost.mjs <tool-cache.json>`,
  );
  process.exit(1);
}

const path = resolveCachePath(process.argv[2]);
const LAZY_FLOOR = Number(process.argv[3] || 886); // the 4 default meta-tools, measured
const tools = JSON.parse(readFileSync(path, "utf8"));
const est = (obj) => Math.ceil(JSON.stringify(obj).length / 4);
const fmt = (n) => Math.round(n).toLocaleString("en-US");

const byServer = new Map();
const perTool = [];
let total = 0;
let fattest = { name: "", tok: 0 };
for (const t of tools) {
  const tok = est(t);
  total += tok;
  perTool.push(tok);
  if (tok > fattest.tok) fattest = { name: t.name || "(unnamed)", tok };
  const server = String(t.name || "").split("__")[0] || "(unknown)";
  const s = byServer.get(server) || { tools: 0, tokens: 0 };
  s.tools += 1;
  s.tokens += tok;
  byServer.set(server, s);
}
perTool.sort((a, b) => a - b);

const rows = [...byServer.entries()]
  .map(([server, s]) => ({ server, ...s }))
  .sort((a, b) => b.tokens - a.tokens);

const reduction = ((1 - LAZY_FLOOR / total) * 100).toFixed(1);
const saved = total - LAZY_FLOOR;
const meanPerTool = total / tools.length;
const median = perTool[Math.floor(perTool.length / 2)];

// --- 1. The catalog ---
console.log(
  `\nMCP tool-catalog token cost: ${tools.length} tools across ${byServer.size} servers\n`,
);
console.log("Per server (definition tokens loaded on every request):");
for (const r of rows) {
  console.log(
    `  ${r.server.padEnd(24)} ${String(r.tools).padStart(4)} tools  ${fmt(r.tokens).padStart(9)} tokens`,
  );
}
console.log("");
console.log(`Without Toolport:  ${fmt(total)} tokens / request`);
console.log(`With Toolport:     ${fmt(LAZY_FLOOR)} tokens / request (meta-tools, flat)`);
console.log(`Reduction:        ${reduction}%`);

// --- 2. Per-tool distribution ---
console.log("");
console.log("Per-tool definition size (tokens):");
console.log(
  `  min ${fmt(perTool[0])}   median ${fmt(median)}   mean ${fmt(meanPerTool)}   max ${fmt(perTool[perTool.length - 1])}`,
);
console.log(`  fattest tool: ${fattest.name} (${fmt(fattest.tok)} tokens)`);

// --- 3. Context-window consumption ---
// How much of a model's input window the tool definitions eat BEFORE any prompt,
// retrieved docs, or conversation. This is the ceiling lazy discovery removes.
const WINDOWS = [
  ["Most local models (8K)", 8000],
  ["GPT-4-class (32K)", 32000],
  ["Claude / GPT-5 (200K)", 200000],
  ["Gemini 2.5 (1M)", 1000000],
];
console.log("");
console.log(
  `Context window eaten by ${fmt(total)} tokens of definitions, before any real work:`,
);
for (const [name, w] of WINDOWS) {
  const pct = (total / w) * 100;
  console.log(
    `  ${name.padEnd(24)} ${pct > 100 ? ">100%  (OVERFLOWS, can't even load the tools)" : pct.toFixed(1) + "%"}`,
  );
}

// --- 4. Scaling: reduction grows with tool count ---
// Uses the measured mean tokens/tool from THIS catalog, so the curve is grounded
// in real schemas. Lazy's floor is fixed at the meta-tools no matter the size.
console.log("");
console.log(
  `Scaling (def-overhead reduction vs tool count, at ${fmt(meanPerTool)} tok/tool measured here):`,
);
console.log("  tools    flat tokens    lazy    reduction");
for (const n of [3, 10, 25, 50, 100, 200, tools.length]) {
  const flat = Math.round(n * meanPerTool);
  const red = (1 - LAZY_FLOOR / flat) * 100;
  console.log(
    `  ${String(n).padStart(5)}    ${fmt(flat).padStart(10)}    ${fmt(LAZY_FLOOR).padStart(4)}    ${red > 0 ? red.toFixed(1) : "0.0"}%`,
  );
}
const breakeven = Math.ceil(LAZY_FLOOR / meanPerTool);
console.log(`  Break-even: lazy beats flat once you connect ~${breakeven} tools.`);

// --- 5. Dollar cost across request volumes ---
// Input-token list prices ($/1M), current as of June 2026.
const PRICES = [
  ["Claude Sonnet ($3/M)", 3],
  ["Claude Opus ($5/M)", 5],
  ["GPT-5.4 ($2.50/M)", 2.5],
  ["Gemini 2.5 Pro ($1.25/M)", 1.25],
];
const VOLUMES = [50, 200, 1000];
console.log("");
console.log(
  `Monthly $ saved (re-sending ${fmt(saved)} tokens/request that lazy mode doesn't):`,
);
console.log("  model".padEnd(28) + VOLUMES.map((v) => `${v}/day`.padStart(12)).join(""));
for (const [label, price] of PRICES) {
  let line = "  " + label.padEnd(26);
  for (const v of VOLUMES) {
    const monthly = (saved / 1e6) * price * v * 30;
    line += `$${fmt(monthly)}`.padStart(12);
  }
  console.log(line);
}
console.log("");
