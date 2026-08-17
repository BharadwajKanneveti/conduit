// Pins SBS-925: Azure signer secrets must not sit on the release job env.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const AZURE_SIGNER_KEYS = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
] as const;
const TAURI_SIGNER_KEYS = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
] as const;
const APPLE_SIGNER_KEYS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_PROVISIONING_PROFILE_APP",
  "APPLE_PROVISIONING_PROFILE_GATEWAY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
] as const;

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}
interface WorkflowJob {
  env?: Record<string, string>;
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

function envKeys(env: Record<string, string> | undefined): string[] {
  return env ? Object.keys(env) : [];
}

function envHasAny(
  env: Record<string, string> | undefined,
  keys: readonly string[],
): boolean {
  return keys.some((k) => envKeys(env).includes(k));
}

function stepByName(job: WorkflowJob, name: string): WorkflowStep | undefined {
  return (job.steps ?? []).find((s) => s.name === name);
}

function jobLevelSignerSecrets(job: WorkflowJob): string[] {
  return AZURE_SIGNER_KEYS.filter((k) => envKeys(job.env).includes(k));
}

const release = parseWorkflow(
  readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8"),
);
const build = release.jobs!.build;

describe("release Azure signer env scope (SBS-925)", () => {
  it("does not put Azure signer secrets on the build job env", () => {
    expect(jobLevelSignerSecrets(build)).toEqual([]);
    expect(envHasAny(build.env, TAURI_SIGNER_KEYS)).toBe(false);
    expect(envHasAny(build.env, APPLE_SIGNER_KEYS)).toBe(false);
  });

  it("keeps frontend and signer setup steps free of Azure signer secrets", () => {
    const names = [
      "Install dependencies",
      "Set up Windows code signing (Azure Trusted Signing)",
      "Cache trusted-signing-cli",
    ];
    for (const name of names) {
      const step = stepByName(build, name);
      expect(step, name).toBeDefined();
      expect(envHasAny(step!.env, AZURE_SIGNER_KEYS), name).toBe(false);
    }
  });

  it("injects Azure signer secrets only on the Windows-gated Build installer step", () => {
    const step = stepByName(build, "Build installer");
    expect(step).toBeDefined();
    for (const key of AZURE_SIGNER_KEYS) {
      const value = step!.env?.[key];
      expect(value, key).toBeDefined();
      expect(value, key).toContain("windows-latest");
      expect(value, key).toContain("secrets." + key);
    }
    for (const key of TAURI_SIGNER_KEYS) {
      expect(step!.env?.[key]).toContain("secrets." + key);
    }
  });

  it("keeps APPLE secrets on the macOS signing step only", () => {
    const step = stepByName(build, "Sign + notarize + package (macOS)");
    expect(step).toBeDefined();
    expect(step!.if).toMatch(/macos/);
    for (const key of APPLE_SIGNER_KEYS) {
      expect(step!.env?.[key]).toContain("secrets." + key);
    }
    for (const s of build.steps ?? []) {
      if (s !== step) expect(envHasAny(s.env, APPLE_SIGNER_KEYS), s.name).toBe(false);
    }
  });

  it("gates Windows signing setup on a boolean, not the secret value", () => {
    const setup = stepByName(
      build,
      "Set up Windows code signing (Azure Trusted Signing)",
    );
    const cache = stepByName(build, "Cache trusted-signing-cli");
    expect(build.env?.AZURE_SIGNING_CONFIGURED).toContain("secrets.AZURE_CLIENT_ID");
    expect(setup?.if).toContain("AZURE_SIGNING_CONFIGURED");
    expect(cache?.if).toContain("AZURE_SIGNING_CONFIGURED");
    expect(setup?.env?.AZURE_SIGNING_CONFIGURED).toBeUndefined();
    expect(cache?.env?.AZURE_SIGNING_CONFIGURED).toBeUndefined();
    expect(envHasAny(setup?.env, AZURE_SIGNER_KEYS)).toBe(false);
    expect(envHasAny(cache?.env, AZURE_SIGNER_KEYS)).toBe(false);
  });
});

describe("the Azure env assertions reject a workflow that reopens the hole", () => {
  it("rejects Azure signer secrets on the job env", () => {
    const fixture = parseWorkflow(
      "jobs:\n  build:\n    env:\n      AZURE_CLIENT_SECRET: x\n    steps:\n      - run: true\n",
    );
    expect(jobLevelSignerSecrets(fixture.jobs!.build)).toEqual(["AZURE_CLIENT_SECRET"]);
  });

  it("rejects Azure signer secrets on the frontend install step", () => {
    const fixture = parseWorkflow(
      "jobs:\n  build:\n    steps:\n      - name: Install dependencies\n        run: echo ci\n        env:\n          AZURE_CLIENT_ID: x\n",
    );
    const step = stepByName(fixture.jobs!.build, "Install dependencies");
    expect(envHasAny(step?.env, AZURE_SIGNER_KEYS)).toBe(true);
  });

  it("rejects a Build installer step that dropped the Azure signer env", () => {
    const fixture = parseWorkflow(
      "jobs:\n  build:\n    steps:\n      - name: Build installer\n        run: echo build\n        env:\n          TAURI_SIGNING_PRIVATE_KEY: x\n",
    );
    const step = stepByName(fixture.jobs!.build, "Build installer");
    expect(step?.env?.AZURE_CLIENT_SECRET).toBeUndefined();
  });
});
