#!/usr/bin/env node
// Deterministic MCP server shared by the local-gateway comparison harness.
// It intentionally has no package dependencies: both products launch this exact
// process and ingest the exact same generated catalog.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const catalogPath = process.argv[2];
if (!catalogPath) {
  console.error("usage: node fixture-mcp.mjs <catalog.json>");
  process.exit(2);
}

const tools = JSON.parse(readFileSync(catalogPath, "utf8")).tools;
if (!Array.isArray(tools)) {
  console.error("catalog must contain a tools array");
  process.exit(2);
}

const byName = new Map(tools.map((tool) => [tool.name, tool]));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id == null) return;

  switch (request.method) {
    case "initialize":
      result(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "toolport-benchmark-fixture", version: "1" },
      });
      break;
    case "ping":
      result(request.id, {});
      break;
    case "tools/list":
      result(request.id, { tools });
      break;
    case "tools/call": {
      const name = request.params?.name;
      if (!byName.has(name)) {
        error(request.id, -32602, `unknown fixture tool: ${name}`);
        break;
      }
      result(request.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              tool: name,
              arguments: request.params?.arguments ?? {},
            }),
          },
        ],
        isError: false,
      });
      break;
    }
    default:
      error(request.id, -32601, `method not found: ${request.method}`);
  }
});
