import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HooksView as HooksViewData } from "@/lib/types";

const api = vi.hoisted(() => ({
  hooksView: vi.fn(),
  hooksSetEnabled: vi.fn(),
  hooksPreview: vi.fn(),
  hooksRecent: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import { HooksView } from "./HooksView";

function view(over: Partial<HooksViewData> = {}): HooksViewData {
  return {
    enabled: false,
    events: ["SessionStart", "PostToolUse", "SessionEnd"],
    profiles: [
      { path: "/home/a/.claude/settings.json", installed: false },
      { path: "/home/a/.claude-work/settings.json", installed: false },
    ],
    binary: "/opt/Toolport/toolport-gateway",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.hooksView.mockResolvedValue(view());
  api.hooksRecent.mockResolvedValue([]);
  api.hooksPreview.mockResolvedValue([]);
  api.hooksSetEnabled.mockImplementation((enabled: boolean) =>
    Promise.resolve(view({ enabled })),
  );
});

describe("HooksView", () => {
  it("starts off, and says so", async () => {
    render(<HooksView />);
    const toggle = await screen.findByLabelText("Record what my agents do");
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/0 of 2 carry the recorder/)).toBeInTheDocument();
  });

  it("states the two promises the backend actually holds", async () => {
    render(<HooksView />);
    // These are the claims that justify letting it watch an agent. If the wording ever drifts
    // from what the backend does, this is the test that should be updated last, not first.
    expect(await screen.findByText(/cannot stop your agent/i)).toBeInTheDocument();
    expect(screen.getByText(/does not read your work/i)).toBeInTheDocument();
  });

  it("turns the recorder on and reseats itself on the returned view", async () => {
    render(<HooksView />);
    const toggle = await screen.findByLabelText("Record what my agents do");

    await userEvent.click(toggle);

    expect(api.hooksSetEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("keeps the toggle honest when the backend refuses", async () => {
    // A failed enable must not leave the box ticked: the backend commits the opt-in and the
    // install together, so a refusal means nothing was turned on.
    api.hooksSetEnabled.mockRejectedValue(
      "no gateway binary is available to run as a hook",
    );
    render(<HooksView />);
    const toggle = await screen.findByLabelText("Record what my agents do");

    await userEvent.click(toggle);

    expect(await screen.findByText(/no gateway binary/i)).toBeInTheDocument();
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("cannot be switched on when no gateway binary exists", async () => {
    api.hooksView.mockResolvedValue(view({ binary: undefined }));
    render(<HooksView />);

    const toggle = await screen.findByLabelText("Record what my agents do");
    expect(toggle).toBeDisabled();
    expect(screen.getByText(/no gateway binary has been published/i)).toBeInTheDocument();
  });

  it("shows a profile that could not be read as unknown, not as off", async () => {
    api.hooksView.mockResolvedValue(
      view({
        enabled: true,
        profiles: [
          { path: "/home/a/.claude/settings.json", installed: true },
          {
            path: "/home/a/.claude-work/settings.json",
            installed: false,
            error: "JSON syntax error at line 3 column 1",
          },
        ],
      }),
    );
    render(<HooksView />);

    expect(await screen.findByText("Could not read")).toBeInTheDocument();
    expect(screen.getByText("Recording")).toBeInTheDocument();
    expect(screen.getByText(/left untouched/i)).toBeInTheDocument();
  });

  it("lists every profile, because one machine has more than one", async () => {
    api.hooksView.mockResolvedValue(view({ enabled: true }));
    render(<HooksView />);

    expect(await screen.findByText("/home/a/.claude/settings.json")).toBeInTheDocument();
    expect(screen.getByText("/home/a/.claude-work/settings.json")).toBeInTheDocument();
  });

  it("does not report an unreadable log as no activity", async () => {
    // The SBS-873 rule on the UI side: a log we failed to read is unknown, and rendering it as
    // "nothing yet" would tell the user the recorder is idle when it may be working fine.
    api.hooksRecent.mockRejectedValue("permission denied");
    render(<HooksView />);

    expect(await screen.findByText(/count is unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing yet/i)).not.toBeInTheDocument();
  });

  it("counts recorded events and names the most recent tool", async () => {
    api.hooksView.mockResolvedValue(view({ enabled: true }));
    api.hooksRecent.mockResolvedValue([
      { event: "tool", tool: "Bash", sessionId: "s1" },
      { event: "session-start", sessionId: "s1" },
    ]);
    render(<HooksView />);

    expect(
      await screen.findByText(/2 recent events, most recently Bash\./),
    ).toBeInTheDocument();
  });

  it("previews the exact bytes without writing", async () => {
    api.hooksPreview.mockResolvedValue([
      {
        path: "/home/a/.claude/settings.json",
        before: '{\n  // keep me\n  "model": "opus"\n}\n',
        after: '{\n  // keep me\n  "model": "opus",\n  "hooks": {}\n}\n',
      },
    ]);
    render(<HooksView />);

    await userEvent.click(await screen.findByRole("button", { name: /preview/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("// keep me");
    expect(dialog).toHaveTextContent(/Nothing has been written/i);
    // Nothing was installed to render it.
    expect(api.hooksSetEnabled).not.toHaveBeenCalled();
  });

  it("says a previewed file would be created when it does not exist yet", async () => {
    api.hooksPreview.mockResolvedValue([
      {
        path: "/home/a/.claude/settings.json",
        before: "",
        after: '{\n  "hooks": {}\n}\n',
      },
    ]);
    render(<HooksView />);

    await userEvent.click(await screen.findByRole("button", { name: /preview/i }));

    expect(await screen.findByText(/would be created/i)).toBeInTheDocument();
  });

  it("surfaces a failed load instead of rendering an empty tab", async () => {
    api.hooksView.mockRejectedValue("data directory is unavailable");
    render(<HooksView />);

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/data directory is unavailable/)).toBeInTheDocument();
  });
});
