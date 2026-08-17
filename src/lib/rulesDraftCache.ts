/**
 * Unsaved Agent-rules editor text, surviving the view's unmount.
 *
 * `App.tsx` mounts the Rules view only while its tab is selected, and the keyboard shortcuts stay
 * live inside a textarea, so Ctrl+2 or a click on Teams tears the component down mid-sentence.
 * In-tab actions flush the draft precisely so typed rules are never lost; leaving the tab has to
 * honour the same promise.
 *
 * Held in memory, NOT auto-saved on the way out: a save applies to every opted-in client, so
 * rewriting someone's `AGENTS.md` because they changed tabs would be far worse than keeping the
 * text here until they come back. Keyed by rule-set id, so a draft can only ever be restored onto
 * the set it was typed for. Lives as long as the window it belongs to.
 *
 * A module rather than component state for the obvious reason (it must outlive the component), and
 * its own file so the view keeps exporting only a component (react-refresh).
 */
const drafts = new Map<string, { name: string; content: string }>();

/** The draft held for a set, if any. */
export function getRulesDraft(setId: string) {
  return drafts.get(setId);
}

/** Hold a draft for a set, replacing any previous one. */
export function setRulesDraft(setId: string, draft: { name: string; content: string }) {
  drafts.set(setId, draft);
}

/** Forget the draft for one set: it was saved, or edited back to the saved text. */
export function forgetRulesDraft(setId: string) {
  drafts.delete(setId);
}

/**
 * Forget every held draft. Module state outlives a component, so tests reset it between cases or
 * one case's typing shows up as another's "unsaved" text.
 */
export function clearRulesDraftCache() {
  drafts.clear();
}
