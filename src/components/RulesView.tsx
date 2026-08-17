import { useEffect, useState } from "react";
import { Eye, FileText, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/Callout";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RuleStateBadge } from "@/components/RuleStateBadge";
import {
  rulesApply,
  rulesDeleteSet,
  rulesPreview,
  rulesSaveSet,
  rulesSetActive,
  rulesSetClientEnabled,
  rulesView,
} from "@/lib/api";
import type { RulesPreview, RulesView as RulesViewData } from "@/lib/types";

/**
 * Agent rules: write your own instructions once and have Toolport put them in every AI client's
 * rules file (CLAUDE.md, AGENTS.md, GEMINI.md, and the rest) instead of editing each by hand.
 *
 * Two things this screen is careful about, because they involve writing into files the user owns:
 *
 *   * A client receives nothing until it is switched on here.
 *   * "Preview" shows the exact bytes that would land, before anything is written.
 *
 * Needs no MCP server and no gateway, so it works on a fresh install.
 */
export function RulesView() {
  const [data, setData] = useState<RulesViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The editor is a local draft so typing never round-trips to disk. Every view refresh goes
  // through `adopt`, which reseats the draft on the active set, so one set's text can never be
  // carried into another and saved over it.
  const [draft, setDraft] = useState("");
  const [draftName, setDraftName] = useState("");

  const [preview, setPreview] = useState<RulesPreview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const active = data?.sets.find((s) => s.id === data.activeSetId) ?? null;
  const dirty =
    active !== null && (draft !== active.content || draftName !== active.name);

  function adopt(next: RulesViewData) {
    setData(next);
    const set = next.sets.find((s) => s.id === next.activeSetId) ?? null;
    setDraft(set?.content ?? "");
    setDraftName(set?.name ?? "");
  }

  useEffect(() => {
    let cancelled = false;
    rulesView()
      .then((v) => {
        if (!cancelled) adopt(v);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Run a mutating call, adopt the refreshed view, and surface any failure in place. */
  async function run(fn: () => Promise<RulesViewData>) {
    setBusy(true);
    setError(null);
    try {
      adopt(await fn());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Switch the edited set. An unsaved draft is kept by saving it first, never silently dropped. */
  async function selectSet(id: string) {
    if (dirty && active) {
      const name = draftName;
      const content = draft;
      await run(async () => {
        await rulesSaveSet(name, content, active.id);
        return rulesSetActive(id);
      });
      return;
    }
    await run(() => rulesSetActive(id));
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const clients = data?.clients ?? [];
  const supported = clients.filter((c) => c.path);
  const unsupported = clients.filter((c) => !c.path);
  const onCount = supported.filter((c) => c.enabled).length;

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <Callout variant="danger" role="alert">
          {error}
        </Callout>
      )}

      <div className="rounded-xl border bg-card p-5">
        <div className="mb-1 flex items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Your agent rules</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Written into each client's own rules file next to, never over, anything you
          already have there. Turning a client off removes what Toolport put in it.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {(data?.sets ?? []).map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => selectSet(s.id)}
              aria-current={s.id === data?.activeSetId}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                s.id === data?.activeSetId
                  ? "border-primary bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {s.name}
            </button>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => run(() => rulesSaveSet("New rules", ""))}
          >
            <Plus className="size-3.5" />
            New set
          </Button>
        </div>

        {active ? (
          <>
            <Input
              value={draftName}
              disabled={busy}
              aria-label="Rule set name"
              onChange={(e) => setDraftName(e.target.value)}
              className="mb-2 h-9"
            />
            <textarea
              value={draft}
              disabled={busy}
              aria-label="Rules"
              onChange={(e) => setDraft(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder="Always run the tests before you say you're done."
              className="mb-3 w-full resize-y rounded-lg border bg-background p-3 font-mono text-xs text-foreground"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy || !dirty}
                onClick={() => run(() => rulesSaveSet(draftName, draft, active.id))}
              >
                {dirty ? "Save and apply" : "Saved"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run(rulesApply)}
              >
                <RefreshCw className="size-3.5" />
                Re-apply
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmDelete(active.id)}
              >
                <Trash2 className="size-3.5" />
                Delete set
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No rule set yet. Create one and it applies to the clients you switch on below.
          </p>
        )}
      </div>

      <div className="rounded-xl border bg-card p-5">
        <h2 className="mb-1 text-sm font-medium">Clients</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          {supported.length === 0
            ? "No AI clients with a rules file Toolport can manage were found on this machine."
            : `${onCount} of ${supported.length} switched on. Nothing is written to a client until you turn it on.`}
        </p>

        <ul className="grid gap-1.5">
          {supported.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
              <label className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.enabled}
                  disabled={busy}
                  aria-label={c.name}
                  onChange={(e) =>
                    run(() => rulesSetClientEnabled(c.id, e.target.checked))
                  }
                />
                <span className="truncate" title={c.path}>
                  {c.name}
                </span>
              </label>
              <span className="flex shrink-0 items-center gap-2">
                {c.enabled && <RuleStateBadge state={c.state} />}
                <button
                  type="button"
                  disabled={busy || !active}
                  title={
                    active
                      ? "See exactly what would be written"
                      : "Create a rule set first"
                  }
                  onClick={async () => {
                    try {
                      setPreview(await rulesPreview(c.id));
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Eye className="size-3" />
                  Preview
                </button>
              </span>
            </li>
          ))}
        </ul>

        {unsupported.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            No rules file Toolport can write for{" "}
            {unsupported.map((c) => c.name).join(", ")}. Paste your rules in by hand.
          </p>
        )}
      </div>

      {preview && (
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium">Preview</h2>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          <p className="mb-3 font-mono text-xs break-all text-muted-foreground">
            {preview.path}
          </p>
          <p className="mb-2 text-xs text-muted-foreground">
            {preview.strategy === "ownedFile"
              ? "Toolport owns this whole file. Nothing of yours lives in it."
              : "Toolport owns only the marked block. Every other byte in this file is left exactly as it is."}
          </p>
          <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap text-foreground">
            {preview.after}
          </pre>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Delete this rule set?"
        description="Toolport removes what it wrote from every client. Your own content in those files is left alone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(null);
          if (id) void run(() => rulesDeleteSet(id));
        }}
      />
    </div>
  );
}
