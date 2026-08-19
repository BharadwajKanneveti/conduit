// Pins SBS-926: docker-publish must never restore the workspace target with
// actions/cache, because Cargo can then upload a stale gateway binary.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function parseWorkflow(source: string): Workflow {
  const workflow = parse(source) as Workflow | null;
  if (!workflow?.jobs || typeof workflow.jobs !== "object") {
    throw new Error("workflow has no jobs: block");
  }
  return workflow;
}

function assertSafeGatewayCache(job: WorkflowJob): void {
  const steps = job.steps ?? [];
  const rustCache = steps.filter((step) => step.uses?.startsWith("Swatinem/rust-cache@"));
  expect(rustCache).toHaveLength(1);
  expect(rustCache[0].uses).toBe(
    "Swatinem/rust-cache@e18b497796c12c097a38f9edb9d0641fb99eee32",
  );
  expect(rustCache[0].with?.workspaces).toBe("src-tauri");
  expect(rustCache[0].with?.key).toBe("docker-gateway");
  expect(rustCache[0].with?.["cache-bin"]).toBe("false");

  const unsafeTargetCaches = steps.filter(
    (step) =>
      step.uses?.startsWith("actions/cache") &&
      String(step.with?.path ?? "").includes("src-tauri/target"),
  );
  expect(unsafeTargetCaches).toEqual([]);
}

const workflow = parseWorkflow(
  readFileSync(join(process.cwd(), ".github", "workflows", "docker-publish.yml"), "utf8"),
);

describe("docker publish Rust cache (SBS-926)", () => {
  it("evicts workspace crates instead of restoring src-tauri/target wholesale", () => {
    assertSafeGatewayCache(workflow.jobs!["build-gateway"]);
  });

  it.each(["actions/cache@sha", "actions/cache/restore@sha", "actions/cache/save@sha"])(
    "rejects the stale workspace-target cache shape from %s",
    (cacheAction) => {
      const fixture = parseWorkflow(`
jobs:
  build-gateway:
    steps:
      - uses: ${cacheAction}
        with:
          path: src-tauri/target
      - uses: Swatinem/rust-cache@sha
        with:
          workspaces: src-tauri
`);
      expect(() => assertSafeGatewayCache(fixture.jobs!["build-gateway"])).toThrow();
    },
  );
});
