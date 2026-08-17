import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RulesView as RulesViewData } from "@/lib/types";

const api = vi.hoisted(() => ({
  rulesView: vi.fn(),
  rulesSaveSet: vi.fn(),
  rulesDeleteSet: vi.fn(),
  rulesSetActive: vi.fn(),
  rulesSetClientEnabled: vi.fn(),
  rulesPreview: vi.fn(),
  rulesApply: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import { RulesView } from "./RulesView";

function view(over: Partial<RulesViewData> = {}): RulesViewData {
  return {
    sets: [{ id: "work", name: "Work", content: "Always run tests.", revision: 2 }],
    activeSetId: "work",
    clients: [
      {
        id: "codex",
        name: "Codex",
        enabled: true,
        path: "/home/a/.codex/AGENTS.md",
        state: "applied",
      },
      {
        id: "claude-code",
        name: "Claude Code",
        enabled: false,
        path: "/home/a/.claude/rules/toolport-rules.md",
        state: "stale",
      },
      { id: "cursor", name: "Cursor", enabled: false, state: "unsupported" },
    ],
    ...over,
  };
}

describe("RulesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.rulesView.mockResolvedValue(view());
  });

  it("loads the active set into the editor and shows per-client state", async () => {
    render(<RulesView />);
    expect(await screen.findByLabelText("Rules")).toHaveValue("Always run tests.");
    expect(screen.getByLabelText("Rule set name")).toHaveValue("Work");

    // An opted-in client shows its state; an opted-out one does not claim to be applied.
    expect(screen.getByLabelText("Codex")).toBeChecked();
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByLabelText("Claude Code")).not.toBeChecked();
    expect(screen.queryByText("Not applied yet")).not.toBeInTheDocument();
  });

  it("names the clients it cannot write instead of hiding them", async () => {
    render(<RulesView />);
    await screen.findByLabelText("Rules");
    // Cursor has no rules file we manage: it must be called out, not silently dropped, or the
    // user thinks their rules reached it.
    expect(screen.getByText(/No rules file Toolport can write for/)).toHaveTextContent(
      "Cursor",
    );
    expect(screen.queryByLabelText("Cursor")).not.toBeInTheDocument();
  });

  it("saves only once the draft differs, and sends the edited text", async () => {
    api.rulesSaveSet.mockResolvedValue(
      view({ sets: [{ id: "work", name: "Work", content: "Be brief.", revision: 3 }] }),
    );
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    // Nothing to save yet.
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();

    await userEvent.clear(editor);
    await userEvent.type(editor, "Be brief.");
    await userEvent.click(screen.getByRole("button", { name: "Save and apply" }));

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith("Work", "Be brief.", "work"),
    );
  });

  it("toggling a client off calls through with false", async () => {
    api.rulesSetClientEnabled.mockResolvedValue(view());
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getByLabelText("Codex"));
    await waitFor(() =>
      expect(api.rulesSetClientEnabled).toHaveBeenCalledWith("codex", false),
    );
  });

  it("preview shows the exact bytes and writes nothing", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "# Mine\n",
      after: "# Mine\n\n<!-- toolport:rules:start -->\nAlways run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);

    expect(await screen.findByText(/toolport:rules:start/)).toBeInTheDocument();
    expect(screen.getByText(/owns only the marked block/)).toBeInTheDocument();
    expect(api.rulesApply).not.toHaveBeenCalled();
    expect(api.rulesSaveSet).not.toHaveBeenCalled();
  });

  it("switching sets saves an unsaved draft first, so edits are never dropped", async () => {
    api.rulesView.mockResolvedValue(
      view({
        sets: [
          { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
          { id: "personal", name: "Personal", content: "Be brief.", revision: 1 },
        ],
      }),
    );
    api.rulesSaveSet.mockResolvedValue(view());
    api.rulesSetActive.mockResolvedValue(view());
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(screen.getByRole("button", { name: "Personal" }));

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith(
        "Work",
        "Always run tests. And lint.",
        "work",
      ),
    );
    expect(api.rulesSetActive).toHaveBeenCalledWith("personal");
  });

  it("with no set, the editor is replaced by a prompt and preview is unavailable", async () => {
    api.rulesView.mockResolvedValue(view({ sets: [], activeSetId: undefined }));
    render(<RulesView />);

    expect(await screen.findByText(/No rule set yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Rules")).not.toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /Preview/ })) {
      expect(b).toBeDisabled();
    }
  });

  it("surfaces a failed write instead of leaving the UI looking clean", async () => {
    api.rulesSetClientEnabled.mockRejectedValue(new Error("permission denied"));
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getByLabelText("Claude Code"));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });
});
