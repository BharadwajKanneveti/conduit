import { describe, expect, it } from "vitest";
import { serverPostureCopy } from "./App";

describe("serverPostureCopy", () => {
  it("reports a confirmed healthy check", () => {
    expect(
      serverPostureCopy({
        backendReachable: true,
        probing: false,
        enabled: 3,
        checked: 3,
        connected: 3,
        attention: 0,
        disabled: 1,
      }),
    ).toEqual({
      healthy: true,
      title: "3 enabled servers reachable",
      detail: "1 disabled in this profile.",
    });
  });

  it("does not claim health while a check is incomplete", () => {
    const posture = serverPostureCopy({
      backendReachable: true,
      probing: true,
      enabled: 3,
      checked: 1,
      connected: 1,
      attention: 0,
      disabled: 0,
    });

    expect(posture.healthy).toBe(false);
    expect(posture.title).toBe("Checking server reachability");
    expect(posture.detail).toBe("1 of 3 checked so far.");
  });

  it("names attention without turning it into a global protection claim", () => {
    const posture = serverPostureCopy({
      backendReachable: true,
      probing: false,
      enabled: 3,
      checked: 3,
      connected: 2,
      attention: 1,
      disabled: 0,
    });

    expect(posture.healthy).toBe(false);
    expect(posture.title).toBe("2 of 3 enabled servers reachable");
    expect(posture.detail).toBe("1 needs a quick check.");
  });

  it("treats a failed health read as unknown, never all-clear", () => {
    const posture = serverPostureCopy({
      backendReachable: false,
      probing: false,
      enabled: 3,
      checked: 3,
      connected: 3,
      attention: 0,
      disabled: 0,
    });

    expect(posture.healthy).toBe(false);
    expect(posture.title).toBe("Reachability status unavailable");
    expect(posture.detail).toContain("Status may be out of date");
  });
});
