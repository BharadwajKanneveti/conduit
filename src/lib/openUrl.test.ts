import { describe, it, expect, vi, beforeEach } from "vitest";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

// Import after mock so the module binds to the mock.
const { openExternal } = await import("./openUrl");

describe("openExternal", () => {
  beforeEach(() => {
    openUrl.mockClear();
  });

  it("allows http and https URLs through to the opener", async () => {
    await openExternal("https://example.com/docs");
    await openExternal("http://localhost:3000");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
    expect(openUrl).toHaveBeenCalledWith("http://localhost:3000");
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps loopback and private-LAN docs reachable", async () => {
    await openExternal("http://127.0.0.1:8080/docs");
    await openExternal("http://192.168.1.10/manual");
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("refuses link-local and cloud-metadata hosts", async () => {
    await openExternal("http://169.254.169.254/latest/meta-data/");
    await openExternal("http://169.254.169.254./latest/meta-data/");
    await openExternal("http://100.100.100.200/latest/meta-data/");
    await openExternal("http://0.0.0.0:8080/");
    await openExternal("http://[fe80::1]/");
    await openExternal("http://[::ffff:169.254.169.254]/");
    await openExternal("http://[::]/");
    await openExternal("http://[fd00:ec2::254]/latest/meta-data/");
    await openExternal("http://metadata.google.internal/computeMetadata/v1/");
    await openExternal("http://metadata/computeMetadata/v1/");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("refuses file:, javascript:, malformed, and empty inputs", async () => {
    await openExternal("file:///etc/passwd");
    await openExternal("javascript:alert(1)");
    await openExternal("not a url");
    await openExternal("");
    await openExternal(null);
    await openExternal(undefined);
    await openExternal(42 as unknown as string);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
