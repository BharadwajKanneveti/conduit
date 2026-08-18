import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Clock, Eye, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/Callout";
import { hooksPreview, hooksRecent, hooksSetEnabled, hooksView } from "@/lib/api";
import type {
  HookEvent,
  HookProfileStatus,
  HooksPreview,
  HooksView as HooksViewData,
} from "@/lib/types";

/** How many recent rows to pull just to show that the sensor is producing any. */
const RECENT_SAMPLE = 200;

/**
 * Agent activity: record what your AI agents do OUTSIDE Toolport.
 *
 * Toolport sees every MCP call because it routes them. It sees none of what Claude Code does
 * natively - `Bash`, `Edit`, `Read`, `WebFetch` - because none of that is MCP. This screen turns
 * on a small recorder that Claude Code runs at three points in its own lifecycle.
 *
 * Two claims this screen makes, both of which the backend holds structurally rather than by
 * promise, and both of which are stated here because the user is being asked to let software
 * watch their agent:
 *
 *   * **It cannot stop anything.** The recorder is not registered on the event that can refuse a
 *     tool call, so no bug in it can block your agent.
 *   * **It stores no content.** A row is a tool name, a session, a folder and a fingerprint.
 *     Never the command, never the file, never the output.
 *
 * Needs no MCP server and no gateway, like the Rules tab.
 */
export function HooksView() {
  const [data, setData] = useState<HooksViewData | null>(null);
  const [recent, setRecent] = useState<HookEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<HooksPreview[] | null>(null);

  /**
   * Re-read the view and the recent rows. Deliberately does NOT touch `error`: this also runs
   * after a failed action, to reseat the toggle on what the backend actually did, and clearing
   * the error there would wipe the only explanation the user gets.
   */
  const refresh = useCallback(async () => {
    setData(await hooksView());
    // Best-effort and separate: a log that cannot be read must not blank the whole tab, but it
    // also must not be reported as "no activity". `null` means unknown.
    try {
      setRecent(await hooksRecent(RECENT_SAMPLE));
    } catch {
      setRecent(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  // Mount load, written as a cancellable promise chain rather than an awaited call, to match
  // `RulesView` and to avoid setting state synchronously inside the effect body. `cancelled`
  // stops a slow first read from writing into a tab the user has already left.
  useEffect(() => {
    let cancelled = false;
    hooksView()
      .then(async (v) => {
        if (cancelled) return;
        setData(v);
        try {
          const rows = await hooksRecent(RECENT_SAMPLE);
          if (!cancelled) setRecent(rows);
        } catch {
          if (!cancelled) setRecent(null);
        }
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

  /** Run a mutating call, then reseat the view on whatever it returns. */
  async function act(run: () => Promise<HooksViewData>) {
    setBusy(true);
    setError(null);
    try {
      setData(await run());
      try {
        setRecent(await hooksRecent(RECENT_SAMPLE));
      } catch {
        setRecent(null);
      }
    } catch (e) {
      setError(String(e));
      // The call failed, so the view we hold may no longer match disk. Re-read, rather than leave
      // a toggle showing a state the backend refused to enter. `refresh` keeps the error above;
      // a re-read that failed too leaves both the stale view and the original message, which is
      // the more useful of the two.
      try {
        await refresh();
      } catch {
        /* keep the error that actually explains the failure */
      }
    } finally {
      setBusy(false);
    }
  }

  async function openPreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await hooksPreview());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (!data) {
    return (
      <Callout variant="danger" role="alert">
        <strong className="font-medium">Agent activity could not be read.</strong>{" "}
        {error ?? "Unknown error."}
      </Callout>
    );
  }

  const profiles = data.profiles;
  const installed = profiles.filter((p) => p.installed).length;
  const broken = profiles.filter((p) => p.error).length;
  const canInstall = Boolean(data.binary);

  return (
    <div className="grid gap-4">
      {error && (
        <Callout variant="danger" role="alert">
          <strong className="font-medium">That did not work.</strong> {error}
        </Callout>
      )}

      <div className="rounded-xl border bg-card p-5">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={data.enabled}
            disabled={busy || (!data.enabled && !canInstall)}
            aria-label="Record what my agents do"
            onChange={(e) => {
              // Read the new value now, before the await: React re-renders this controlled input
              // back to `data.enabled` while the call is in flight, so a lazy read inside the
              // callback sees the OLD value and the toggle silently does nothing.
              const next = e.target.checked;
              void act(() => hooksSetEnabled(next));
            }}
          />
          <span className="min-w-0">
            <span className="text-sm font-medium">Record what my agents do</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Claude Code runs a small Toolport recorder when a session starts, after each
              tool it uses, and when the session ends. You get one line per event: which
              tool, in which folder, in which session.
            </span>
          </span>
        </label>

        <ul className="mt-3 grid gap-1 border-t pt-3 text-xs text-muted-foreground">
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span>
              <strong className="font-medium text-foreground">
                It cannot stop your agent.
              </strong>{" "}
              The recorder is not attached to the step that can refuse a tool call, so
              nothing it does can block your work.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span>
              <strong className="font-medium text-foreground">
                It does not read your work.
              </strong>{" "}
              Commands, file contents and tool output are dropped. A row keeps the tool
              name, the folder, the session, and a fingerprint that cannot be turned back
              into the input.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
            <span>
              <strong className="font-medium text-foreground">
                It stays on this machine.
              </strong>{" "}
              Rows are appended to a local file. Turning this off removes the recorder
              from every file Toolport wrote.
            </span>
          </li>
        </ul>

        {!canInstall && !data.enabled && (
          <p className="mt-3 text-xs text-warning">
            No gateway binary has been published yet, so there is nothing to install.
            Connect a client first, then come back.
          </p>
        )}
      </div>

      <div className="rounded-xl border bg-card p-5">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Claude Code profiles</h2>
          <span className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={busy || !canInstall}
              title={
                canInstall
                  ? "See exactly what would be written"
                  : "No gateway binary has been published yet"
              }
              onClick={() => void openPreview()}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Eye className="size-3.5" />
              Preview
            </button>
            <button
              type="button"
              disabled={busy}
              title="Re-read the profiles on disk"
              onClick={() => void load()}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </button>
          </span>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {profiles.length === 0
            ? "No Claude Code profile was found on this machine."
            : `${installed} of ${profiles.length} carry the recorder. A machine can have more than one profile, and each needs it separately.`}
        </p>

        {profiles.length > 0 && (
          <ul className="grid gap-1.5">
            {profiles.map((p) => (
              <li
                key={p.path}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="truncate font-mono text-xs" title={p.path}>
                  {p.path}
                </span>
                <ProfileBadge profile={p} enabled={data.enabled} />
              </li>
            ))}
          </ul>
        )}

        {broken > 0 && (
          <p className="mt-3 text-xs text-warning">
            {broken === 1 ? "One profile" : `${broken} profiles`} could not be read or
            written, so
            {broken === 1 ? " it was" : " they were"} left untouched. Nothing was
            overwritten.
          </p>
        )}
      </div>

      <div className="rounded-xl border bg-card p-5">
        <h2 className="mb-1 text-sm font-medium">Recorded so far</h2>
        <p className="text-xs text-muted-foreground">
          {recent === null ? (
            // Unreadable is NOT the same as empty. Saying "no activity" for a log we failed to
            // read would be a comfortable lie about whether anything is being recorded.
            <span className="text-warning">
              The activity log could not be read, so this count is unknown.
            </span>
          ) : recent.length === 0 ? (
            data.enabled ? (
              "Nothing yet. Start a Claude Code session and events will appear here."
            ) : (
              "Nothing recorded. Turn the recorder on above to start."
            )
          ) : (
            `${recent.length === RECENT_SAMPLE ? `${RECENT_SAMPLE}+` : recent.length} recent ${
              recent.length === 1 ? "event" : "events"
            }${lastToolLabel(recent)}`
          )}
        </p>
      </div>

      {preview && <PreviewDialog previews={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** The most recent named tool, when there is one, as a "you can see it working" signal. */
function lastToolLabel(recent: HookEvent[]): string {
  const tool = recent.find((r) => typeof r.tool === "string" && r.tool.length > 0)?.tool;
  return tool ? `, most recently ${tool}.` : ".";
}

/**
 * One profile's state.
 *
 * An error outranks everything: a profile we could not read is neither "on" nor "off", and
 * rendering it as off would claim we know something we do not.
 */
function ProfileBadge({
  profile,
  enabled,
}: {
  profile: HookProfileStatus;
  enabled: boolean;
}) {
  if (profile.error) {
    return (
      <span
        title={profile.error}
        className="flex shrink-0 items-center gap-1 text-xs text-destructive"
      >
        <AlertTriangle className="size-3.5" />
        Could not read
      </span>
    );
  }
  if (profile.installed) {
    return (
      <span
        title="This profile runs the recorder."
        className="flex shrink-0 items-center gap-1 text-xs text-success"
      >
        <Check className="size-3.5" />
        Recording
      </span>
    );
  }
  return (
    <span
      title={
        enabled
          ? "The recorder is on but has not been written to this profile yet."
          : "Nothing is written to this profile."
      }
      className={`flex shrink-0 items-center gap-1 text-xs ${
        enabled ? "text-warning" : "text-muted-foreground"
      }`}
    >
      <Clock className="size-3.5" />
      {enabled ? "Not written yet" : "Off"}
    </span>
  );
}

/** The exact bytes that would be written, per profile, before anything is. */
function PreviewDialog({
  previews,
  onClose,
}: {
  previews: HooksPreview[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="What would be written"
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col rounded-xl border bg-card shadow-lg">
        <div className="flex items-center justify-between gap-3 border-b p-4">
          <h2 className="text-sm font-medium">What would be written</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="grid gap-4 overflow-auto p-4">
          {previews.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No Claude Code profile was found, so there is nothing to write.
            </p>
          )}
          {previews.map((p) => (
            <div key={p.path} className="grid gap-1">
              <p className="font-mono text-xs text-muted-foreground">{p.path}</p>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                {p.after}
              </pre>
              {p.before === "" && (
                <p className="text-xs text-muted-foreground">
                  This file does not exist yet and would be created.
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="border-t p-4 text-xs text-muted-foreground">
          Nothing has been written. Everything outside the highlighted block, including
          your comments, is left exactly as it is.
        </div>
      </div>
    </div>
  );
}
