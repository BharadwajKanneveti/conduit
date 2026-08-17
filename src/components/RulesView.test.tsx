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

  it("preview says so when the write would be refused, instead of just showing bytes", async () => {
    // Windsurf's cap is a refusal, not a truncation. A preview that looks like any other write,
    // followed by nothing landing, reads as a bug rather than a documented limit.
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "# Mine\n",
      after: "# Mine\n\nAlways run tests.\n",
      state: "too_long",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);

    expect(
      await screen.findByText(/will not be written to this client/),
    ).toHaveTextContent(/hard limit/);
  });

  it("preview shows no warning when the write would land", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "# Mine\n",
      after: "# Mine\n\nAlways run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);

    expect(await screen.findByText(/owns only the marked block/)).toBeInTheDocument();
    expect(
      screen.queryByText(/will not be written to this client/),
    ).not.toBeInTheDocument();
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

  it("creating a set switches to it, so the editor is not still on the old one", async () => {
    // The backend only auto-activates a new set when nothing else is active, so without an
    // explicit select this button would look like it did nothing.
    const created = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
        { id: "new-rules", name: "New rules", content: "", revision: 1 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(created);
    api.rulesSetActive.mockResolvedValue({ ...created, activeSetId: "new-rules" });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getByRole("button", { name: "New set" }));

    await waitFor(() => expect(api.rulesSetActive).toHaveBeenCalledWith("new-rules"));
    expect(screen.getByLabelText("Rules")).toHaveValue("");
    expect(screen.getByLabelText("Rule set name")).toHaveValue("New rules");
  });

  it("creating a set saves an unsaved draft first, so edits are never dropped", async () => {
    const created = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests. And lint.", revision: 3 },
        { id: "new-rules", name: "New rules", content: "", revision: 1 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(created);
    api.rulesSetActive.mockResolvedValue({ ...created, activeSetId: "new-rules" });
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(screen.getByRole("button", { name: "New set" }));

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith(
        "Work",
        "Always run tests. And lint.",
        "work",
      ),
    );
    expect(api.rulesSaveSet).toHaveBeenCalledWith("New rules", "");
  });

  /**
   * "Type your rules, then switch a client on" is the first thing anyone does. Every action that
   * refreshes the view reseats the editor from the SAVED set, so any of them that forgets to
   * flush first silently replaces what the user typed with the old text.
   */
  it.each([
    ["toggling a client", () => screen.getByLabelText("Claude Code")],
    ["Re-apply", () => screen.getByRole("button", { name: "Re-apply" })],
    ["Preview", () => screen.getAllByRole("button", { name: /Preview/ })[0]],
  ])("%s saves an unsaved draft instead of discarding it", async (_label, target) => {
    const saved = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests. And lint.", revision: 3 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(saved);
    api.rulesSetClientEnabled.mockResolvedValue(saved);
    api.rulesApply.mockResolvedValue(saved);
    api.rulesPreview.mockResolvedValue(null);
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(target());

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith(
        "Work",
        "Always run tests. And lint.",
        "work",
      ),
    );
    expect(screen.getByLabelText("Rules")).toHaveValue("Always run tests. And lint.");
  });

  it("clears a stale preview when the view is reseated", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "",
      after: "Always run tests.\n",
      state: "stale",
    });
    api.rulesApply.mockResolvedValue(view());
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);
    expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

    // A preview naming a path and bytes that no longer match the editor is worse than none.
    await userEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    await waitFor(() =>
      expect(screen.queryByText("/home/a/.codex/AGENTS.md")).not.toBeInTheDocument(),
    );
  });

  it("does not claim there are no sets when a deleted set left siblings behind", async () => {
    // `remove_rule_set` clears the selection rather than promoting a sibling, so the other sets
    // are still on screen. Saying none exist would contradict the chips right above.
    api.rulesView.mockResolvedValue(
      view({
        sets: [
          { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
          { id: "personal", name: "Personal", content: "Be brief.", revision: 1 },
        ],
        activeSetId: undefined,
      }),
    );
    render(<RulesView />);

    expect(await screen.findByText(/Pick one above/)).toBeInTheDocument();
    expect(screen.queryByText(/No rule set yet/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Personal" })).toBeInTheDocument();
  });

  it("a failed preview does not leave another client's card on screen", async () => {
    api.rulesPreview.mockResolvedValueOnce({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "",
      after: "Always run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    const previews = screen.getAllByRole("button", { name: /Preview/ });
    await userEvent.click(previews[0]);
    expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

    // Second client's preview fails. Codex's bytes must not sit under the error looking like
    // they belong to Claude Code.
    api.rulesPreview.mockRejectedValueOnce(new Error("permission denied"));
    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[1]);

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.queryByText("/home/a/.codex/AGENTS.md")).not.toBeInTheDocument();
  });

  it("editing clears an open preview instead of letting it go stale", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "",
      after: "Always run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);
    expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

    await userEvent.type(editor, " And lint.");
    expect(screen.queryByText("/home/a/.codex/AGENTS.md")).not.toBeInTheDocument();
  });

  it("a failed load says so instead of claiming the machine is empty", async () => {
    api.rulesView.mockRejectedValue(new Error("registry unreadable"));
    render(<RulesView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("registry unreadable");
    // We never found out what is on this machine, so we must not report an answer.
    expect(screen.queryByText(/No AI clients/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No rule set yet/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
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
