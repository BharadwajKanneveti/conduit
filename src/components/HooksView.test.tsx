import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

  it("offers a way out of a failed load instead of a dead end", async () => {
    // The Refresh button lives inside the profiles card, which a failed load never renders, so
    // without this button the only recovery is leaving the tab and coming back.
    api.hooksView.mockRejectedValueOnce("data directory is unavailable");
    render(<HooksView />);

    const retry = await screen.findByRole("button", { name: /try again/i });
    api.hooksView.mockResolvedValue(view({ enabled: true }));

    await userEvent.click(retry);

    expect(await screen.findByText(/carry the recorder/)).toBeInTheDocument();
    expect(screen.queryByText(/data directory is unavailable/)).not.toBeInTheDocument();
  });

  it("closes the preview on Escape", async () => {
    api.hooksPreview.mockResolvedValue([
      { path: "/home/a/.claude/settings.json", before: "{}", after: '{"hooks":{}}' },
    ]);
    render(<HooksView />);

    await userEvent.click(await screen.findByRole("button", { name: /preview/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("locks the recorder toggle while the preview is open", async () => {
    // The dialog shows the bytes that would be written NEXT. A toggle that still worked behind
    // it would turn that reading into a description of something already done.
    api.hooksPreview.mockResolvedValue([
      { path: "/home/a/.claude/settings.json", before: "{}", after: '{"hooks":{}}' },
    ]);
    render(<HooksView />);
    const toggle = await screen.findByLabelText("Record what my agents do");
    expect(toggle).not.toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /preview/i }));
    await screen.findByRole("dialog");

    expect(toggle).toBeDisabled();
  });

  it("marks Toolport's own lines in the preview", async () => {
    // The footer promises everything outside the added block survives. Highlighting the block is
    // what lets a user check that rather than take it on trust.
    api.hooksPreview.mockResolvedValue([
      {
        path: "/home/a/.claude/settings.json",
        before: "{\n  // keep me\n}\n",
        after: '{\n  // keep me\n  "command": "gw --toolport-hook PostToolUse"\n}\n',
      },
    ]);
    render(<HooksView />);

    await userEvent.click(await screen.findByRole("button", { name: /preview/i }));

    const marked = await screen.findByText(/--toolport-hook/);
    expect(marked.className).toMatch(/bg-success/);
    expect(screen.getByText(/keep me/).className).not.toMatch(/bg-success/);
  });

  it("lists one row per event, with tool, folder and session", async () => {
    // The toggle copy promises "one line per event: which tool, in which folder, in which
    // session". A count alone does not deliver that.
    api.hooksView.mockResolvedValue(view({ enabled: true }));
    api.hooksRecent.mockResolvedValue([
      {
        event: "tool",
        tool: "Bash",
        cwd: "/home/a/projects/toolport",
        sessionId: "abcdef1234567890",
      },
      {
        event: "session-start",
        cwd: "/home/a/projects/toolport",
        sessionId: "abcdef1234567890",
      },
    ]);
    render(<HooksView />);

    expect(await screen.findByText("Bash")).toBeInTheDocument();
    expect(screen.getAllByText("toolport").length).toBe(2);
    expect(screen.getAllByText("abcdef12").length).toBe(2);
    // The count line stays: the rows are a sample, not the whole log.
    expect(screen.getByText(/2 recent events/)).toBeInTheDocument();
  });

  it("keeps an unreadable profile out of the recorder count", async () => {
    // `installed: false` on a profile the backend could not read is the absence of knowledge,
    // not the absence of a recorder. Counting it as off contradicts its own badge.
    api.hooksView.mockResolvedValue(
      view({
        enabled: true,
        profiles: [
          { path: "/home/a/.claude/settings.json", installed: true },
          { path: "/home/a/.claude-alt/settings.json", installed: false },
          {
            path: "/home/a/.claude-work/settings.json",
            installed: false,
            error: "JSON syntax error at line 3 column 1",
          },
        ],
      }),
    );
    render(<HooksView />);

    expect(await screen.findByText(/1 of 2 carry the recorder/)).toBeInTheDocument();
    expect(screen.getByText(/1 more could not be read/)).toBeInTheDocument();
    expect(screen.queryByText(/1 of 3 carry the recorder/)).not.toBeInTheDocument();
  });

  it("picks up events recorded while the tab stays open", async () => {
    // The empty state says "start a Claude Code session and events will appear here", which is
    // only true if the tab looks again. Nothing in the registry changes when an agent runs a
    // tool, so no parent refresh ever fires for it.
    vi.useFakeTimers();
    try {
      api.hooksView.mockResolvedValue(view({ enabled: true }));
      api.hooksRecent.mockResolvedValue([]);
      render(<HooksView />);
      await vi.waitFor(() =>
        expect(screen.getByText(/Nothing yet/i)).toBeInTheDocument(),
      );

      api.hooksRecent.mockResolvedValue([
        { event: "tool", tool: "Edit", cwd: "/home/a/app", sessionId: "s1" },
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      await vi.waitFor(() =>
        expect(
          screen.getByText(/1 recent event, most recently Edit\./),
        ).toBeInTheDocument(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash an error when a background read fails", async () => {
    // A poll the user did not ask for must not turn into a danger callout blinking every few
    // seconds while they read the page.
    vi.useFakeTimers();
    try {
      api.hooksView.mockResolvedValue(view({ enabled: true }));
      api.hooksRecent.mockResolvedValue([
        { event: "tool", tool: "Edit", cwd: "/home/a/app", sessionId: "s1" },
      ]);
      render(<HooksView />);
      await vi.waitFor(() =>
        expect(screen.getByText(/most recently Edit/)).toBeInTheDocument(),
      );

      api.hooksRecent.mockRejectedValue("permission denied");
      api.hooksView.mockRejectedValue("permission denied");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(screen.queryByText(/That did not work/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/count is unknown/i)).not.toBeInTheDocument();
      expect(screen.getByText(/most recently Edit/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads when the parent's refresh counter changes", async () => {
    const { rerender } = render(<HooksView refreshKey={0} />);
    expect(await screen.findByText(/0 of 2 carry the recorder/)).toBeInTheDocument();

    api.hooksView.mockResolvedValue(
      view({
        enabled: true,
        profiles: [
          { path: "/home/a/.claude/settings.json", installed: true },
          { path: "/home/a/.claude-work/settings.json", installed: true },
        ],
      }),
    );
    rerender(<HooksView refreshKey={1} />);

    expect(await screen.findByText(/2 of 2 carry the recorder/)).toBeInTheDocument();
  });
});
