//! Personal agent rules — write the user's own rule set into every opted-in AI client.
//!
//! The desktop half of SBS-821 (`agent-rules` spec). The user authors one or more named
//! [`RuleSet`]s in the app; the active one is written into each client's global rules file so
//! Claude Code, Codex, Gemini CLI and the rest all read the same instructions without the user
//! hand-editing four files.
//!
//! This is the same write engine Team Instructions uses ([`crate::instructions`]), driven from
//! local state instead of a pulled org config: `(rule_set_id, revision)` stands in for
//! `(team_id, version)`, and every target carries [`Scope::Personal`] so a member of a Teams org
//! keeps both sets of rules in the same files without either clobbering the other.
//!
//! Two rules this module exists to enforce:
//!
//!   * **Opt-in per client.** Writing into someone's `~/.claude/rules` or `AGENTS.md` unasked is
//!     not something to do, so [`crate::registry::Registry::rules_client_enabled`] defaults to
//!     off and the UI previews the write first.
//!   * **Clean up exactly what we wrote.** Every applied path is recorded in
//!     `Registry::rules_targets`; anything in that list we do not re-write this pass is removed
//!     by path, so switching set, opting a client out, or uninstalling a client never strands a
//!     file. Same contract as `teams::apply_instructions_to`.

use crate::instructions::{self, ApplyState, Scope, Strategy, Target};
use crate::registry::RuleSet;
use serde::{Deserialize, Serialize};

/// One client's row in the Rules view: whether it is opted in, where its rules file is, and what
/// state that file is in right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub id: String,
    pub name: String,
    /// User opt-in. A disabled client still reports a `state` (usually `Stale`) so the UI can
    /// show what WOULD happen without writing anything.
    pub enabled: bool,
    /// `None` when this client has no global-rules location we can write (Cursor, Warp).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub state: ApplyState,
}

/// Everything the Rules view needs, in one round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesView {
    pub sets: Vec<RuleSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_set_id: Option<String>,
    pub clients: Vec<ClientStatus>,
}

/// A dry run of one client's write, so the user sees the exact bytes before the first apply
/// (SBS-821 acceptance criteria). Never touches disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesPreview {
    pub client_id: String,
    pub path: String,
    /// `"ownedFile"` when Toolport owns the whole file, `"sentinelBlock"` when it owns only the
    /// marked span in a file the user also edits. Drives how the UI frames the change.
    pub strategy: String,
    /// The file as it is now. Empty when it does not exist yet.
    pub before: String,
    /// The file as this apply would leave it.
    pub after: String,
    pub state: ApplyState,
}

/// One installed client and where its personal rules go. Deliberately NOT
/// [`crate::clients::DetectedClient`]: that type carries a client's whole MCP inventory and has no
/// cheap constructor, so depending on it here would make every apply test build a fake server
/// list. This is the only shape the apply logic needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClientTarget {
    id: String,
    name: String,
    /// `None` when this client has no global-rules location we manage (Cursor, Warp), or is
    /// covered transitively by another client's file.
    target: Option<Target>,
}

/// Every installed client paired with its personal-rules target, including clients the user has
/// NOT opted in — the view lists them so they can be turned on.
fn installed_targets() -> Vec<ClientTarget> {
    crate::clients::detect_clients()
        .into_iter()
        .filter(|c| c.app_present)
        .map(|c| ClientTarget {
            target: crate::clients::client_rules_target(&c.id, Scope::Personal),
            id: c.id,
            name: c.name,
        })
        .collect()
}

/// The distinct paths to write this pass: opted-in clients only, de-duped by path so a file two
/// clients share (Claude Code + VS Code Copilot, Gemini CLI + Antigravity) is written once.
fn enabled_targets(reg: &crate::registry::Registry, installed: &[ClientTarget]) -> Vec<Target> {
    let mut seen = std::collections::HashSet::new();
    installed
        .iter()
        .filter(|c| reg.rules_client_enabled(&c.id))
        .filter_map(|c| c.target.clone())
        .filter(|t| seen.insert(t.path.clone()))
        .collect()
}

/// Read-only per-client state for the given set. Reports reality rather than what we last wrote,
/// so a hand-edited or deleted block shows `Stale` and a client installed since the last apply
/// shows up immediately.
fn status_from(
    reg: &crate::registry::Registry,
    installed: &[ClientTarget],
    set: Option<&RuleSet>,
) -> Vec<ClientStatus> {
    installed
        .iter()
        .map(|c| {
            let state = match (&c.target, set) {
                (None, _) => ApplyState::Unsupported,
                // No active set: nothing is meant to be on disk, so nothing is stale.
                (Some(_), None) => ApplyState::Applied,
                (Some(t), Some(s)) => instructions::current_state(t, &s.id, s.revision, &s.content),
            };
            ClientStatus {
                id: c.id.clone(),
                name: c.name.clone(),
                enabled: reg.rules_client_enabled(&c.id),
                path: c
                    .target
                    .as_ref()
                    .map(|t| t.path.to_string_lossy().to_string()),
                state,
            }
        })
        .collect()
}

/// The whole Rules view. Read-only; scans every installed client's rules file, so callers run it
/// off the UI thread.
pub fn view() -> Result<RulesView, String> {
    let reg = crate::registry::load()?;
    let installed = installed_targets();
    let set = reg.active_rule_set().cloned();
    Ok(RulesView {
        clients: status_from(&reg, &installed, set.as_ref()),
        sets: reg.rule_sets.clone(),
        active_set_id: reg.active_rule_set_id.clone(),
    })
}

/// Apply the active rule set to every opted-in client, then clean up anything we wrote before and
/// did not write now. Returns the refreshed view.
///
/// Best-effort per client, like the team writer: one unwritable file must not abort the rest. A
/// client that reports anything other than [`ApplyState::Applied`] is simply not recorded, so the
/// next pass tries it again.
pub fn apply() -> Result<RulesView, String> {
    let installed = installed_targets();
    apply_to(&installed)
}

/// [`apply`] over an explicit client/target set, so tests drive a known set of files instead of
/// the developer's real machine.
fn apply_to(installed: &[ClientTarget]) -> Result<RulesView, String> {
    let reg = crate::registry::load()?;
    let set = reg.active_rule_set().cloned();
    let prev_targets = reg.rules_targets.clone();
    let targets = enabled_targets(&reg, installed);

    let mut written: Vec<String> = Vec::new();
    if let Some(s) = set.as_ref() {
        for target in &targets {
            if instructions::write_target(target, &s.id, s.revision, &s.content)
                == ApplyState::Applied
            {
                written.push(target.path.to_string_lossy().to_string());
            }
        }
    }
    // Anything we wrote before and did not write now: the set changed or was cleared, a client
    // was opted out or uninstalled, or its rules path moved. Iterating the RECORDED list rather
    // than a fresh scan means cleanup survives a client that has since disappeared.
    for old in &prev_targets {
        if !written.iter().any(|w| w == old) {
            instructions::remove_recorded(std::path::Path::new(old), Scope::Personal);
        }
    }

    // Record what is now on disk. The compare-and-set fails if the active set changed underneath
    // us (the user switched sets while we were writing): the files we just wrote would then have
    // no record to clean them by, so roll them back rather than orphan them.
    let expected = set.as_ref().map(|s| (s.id.clone(), s.revision));
    let recorded = crate::registry::update(|reg| {
        let current = reg.active_rule_set().map(|s| (s.id.clone(), s.revision));
        if current != expected {
            return Ok(false);
        }
        reg.rules_targets = written.clone();
        Ok(true)
    });
    if !matches!(recorded, Ok((_, true))) {
        for path in &written {
            instructions::remove_recorded(std::path::Path::new(path), Scope::Personal);
        }
    }

    let reg = crate::registry::load()?;
    let set = reg.active_rule_set().cloned();
    Ok(RulesView {
        clients: status_from(&reg, installed, set.as_ref()),
        sets: reg.rule_sets.clone(),
        active_set_id: reg.active_rule_set_id.clone(),
    })
}

/// Dry-run one client's write. `None` when the client is unknown, not installed, or has no rules
/// location we manage.
pub fn preview(client_id: &str) -> Result<Option<RulesPreview>, String> {
    let reg = crate::registry::load()?;
    let Some(target) = crate::clients::client_rules_target(client_id, Scope::Personal) else {
        return Ok(None);
    };
    let Some(set) = reg.active_rule_set() else {
        return Ok(None);
    };
    let before = std::fs::read_to_string(&target.path).unwrap_or_default();
    let after = match target.strategy {
        Strategy::OwnedFile => {
            instructions::render_owned_file(Scope::Personal, &set.id, set.revision, &set.content)
        }
        Strategy::SentinelBlock => instructions::upsert_block(
            &before,
            Scope::Personal,
            &set.id,
            set.revision,
            &set.content,
        ),
    };
    Ok(Some(RulesPreview {
        client_id: client_id.to_string(),
        path: target.path.to_string_lossy().to_string(),
        strategy: match target.strategy {
            Strategy::OwnedFile => "ownedFile",
            Strategy::SentinelBlock => "sentinelBlock",
        }
        .to_string(),
        state: instructions::current_state(&target, &set.id, set.revision, &set.content),
        before,
        after,
    }))
}

/// Create or update a set, then apply. Returns the refreshed view.
pub fn save_set(id: Option<&str>, name: &str, content: &str) -> Result<RulesView, String> {
    crate::registry::update(|reg| {
        reg.upsert_rule_set(id, name, content);
        Ok(())
    })?;
    apply()
}

/// Delete a set, then apply. Deleting the active set clears the selection, so the apply that
/// follows removes every file we wrote.
pub fn delete_set(id: &str) -> Result<RulesView, String> {
    crate::registry::update(|reg| {
        reg.remove_rule_set(id);
        Ok(())
    })?;
    apply()
}

/// Switch (or clear) the active set, then apply.
pub fn set_active(id: Option<&str>) -> Result<RulesView, String> {
    crate::registry::update(|reg| {
        reg.set_active_rule_set(id);
        Ok(())
    })?;
    apply()
}

/// Opt one client in or out, then apply. Opting out removes that client's file on the same pass.
pub fn set_client_enabled(client_id: &str, enabled: bool) -> Result<RulesView, String> {
    crate::registry::update(|reg| {
        reg.set_rules_client_enabled(client_id, enabled);
        Ok(())
    })?;
    apply()
}

/// Re-assert the active set at startup. Cheap in the common case: [`instructions::write_target`]
/// no-ops when the on-disk block already matches, so a normal launch touches no files. Exists so
/// a client updated (or reinstalled) since the last apply picks the rules back up without the
/// user opening the Rules tab.
pub fn apply_on_startup() {
    if let Ok(reg) = crate::registry::load() {
        if reg.active_rule_set().is_none() && reg.rules_targets.is_empty() {
            return; // nothing configured and nothing written: skip the client scan entirely
        }
    }
    let _ = apply();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A unique scratch dir per test; best-effort cleanup on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "toolport-rules-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn client(id: &str, target: Option<Target>) -> ClientTarget {
        ClientTarget {
            id: id.to_string(),
            name: id.to_string(),
            target,
        }
    }

    fn sentinel(path: PathBuf) -> Target {
        Target {
            path,
            strategy: Strategy::SentinelBlock,
            scope: Scope::Personal,
            char_cap: None,
            blocked_if_present: None,
        }
    }

    fn owned(path: PathBuf) -> Target {
        Target {
            path,
            strategy: Strategy::OwnedFile,
            scope: Scope::Personal,
            char_cap: None,
            blocked_if_present: None,
        }
    }

    fn set(id: &str, revision: i64, content: &str) -> RuleSet {
        RuleSet {
            id: id.to_string(),
            name: id.to_string(),
            content: content.to_string(),
            revision,
        }
    }

    // ---- registry-level set management (no filesystem) ----

    #[test]
    fn a_new_set_becomes_active_when_nothing_else_is() {
        let mut reg = crate::registry::Registry::default();
        let id = reg.upsert_rule_set(None, "Work", "Always run tests.");
        assert_eq!(reg.active_rule_set_id.as_deref(), Some(id.as_str()));
        assert_eq!(reg.active_rule_set().map(|s| s.revision), Some(1));

        // A SECOND set does not steal the selection.
        let other = reg.upsert_rule_set(None, "Personal", "Be brief.");
        assert_ne!(other, id, "ids must be unique");
        assert_eq!(reg.active_rule_set_id.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn revision_moves_on_content_change_only() {
        let mut reg = crate::registry::Registry::default();
        let id = reg.upsert_rule_set(None, "Work", "v1");
        assert_eq!(reg.active_rule_set().unwrap().revision, 1);

        // A rename rides in the marker but is not a content change, so rewriting every client's
        // file for it would be pure churn.
        reg.upsert_rule_set(Some(&id), "Renamed", "v1");
        assert_eq!(reg.active_rule_set().unwrap().revision, 1);
        assert_eq!(reg.active_rule_set().unwrap().name, "Renamed");

        reg.upsert_rule_set(Some(&id), "Renamed", "v2");
        assert_eq!(reg.active_rule_set().unwrap().revision, 2);
    }

    #[test]
    fn removing_the_active_set_clears_the_selection() {
        let mut reg = crate::registry::Registry::default();
        let a = reg.upsert_rule_set(None, "A", "a");
        let b = reg.upsert_rule_set(None, "B", "b");
        reg.remove_rule_set(&a);
        assert_eq!(
            reg.active_rule_set_id, None,
            "must not silently promote another set's rules onto the user's machine"
        );
        assert_eq!(reg.rule_sets.len(), 1);

        reg.set_active_rule_set(Some(&b));
        assert_eq!(reg.active_rule_set_id.as_deref(), Some(b.as_str()));
        reg.set_active_rule_set(Some("nope"));
        assert_eq!(reg.active_rule_set_id, None, "unknown id clears, never panics");
    }

    #[test]
    fn a_client_is_opted_out_until_the_user_says_otherwise() {
        let mut reg = crate::registry::Registry::default();
        assert!(!reg.rules_client_enabled("claude-code"), "absent must mean off");
        reg.set_rules_client_enabled("claude-code", true);
        assert!(reg.rules_client_enabled("claude-code"));
        reg.set_rules_client_enabled("claude-code", false);
        assert!(!reg.rules_client_enabled("claude-code"));
        assert!(
            reg.rules_clients.contains_key("claude-code"),
            "an explicit off is stored, so the UI can tell it from never-seen"
        );
    }

    // ---- target selection ----

    #[test]
    fn only_opted_in_clients_are_written_and_shared_paths_collapse() {
        let s = Scratch::new();
        let shared = s.path("GEMINI.md");
        let installed = vec![
            client("gemini-cli", Some(sentinel(shared.clone()))),
            client("antigravity", Some(sentinel(shared.clone()))),
            client("codex", Some(sentinel(s.path("AGENTS.md")))),
            client("cursor", None),
        ];
        let mut reg = crate::registry::Registry::default();

        assert!(
            enabled_targets(&reg, &installed).is_empty(),
            "nothing is written before the user opts a client in"
        );

        reg.set_rules_client_enabled("gemini-cli", true);
        reg.set_rules_client_enabled("antigravity", true);
        let targets = enabled_targets(&reg, &installed);
        assert_eq!(
            targets.len(),
            1,
            "Gemini and Antigravity share one file; it must be written once"
        );
        assert_eq!(targets[0].path, shared);
    }

    #[test]
    fn an_unsupported_client_is_reported_not_skipped() {
        let installed = vec![client("cursor", None)];
        let reg = crate::registry::Registry::default();
        let rows = status_from(&reg, &installed, Some(&set("s", 1, "c")));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, ApplyState::Unsupported);
        assert_eq!(rows[0].path, None);
        assert!(!rows[0].enabled);
    }

    #[test]
    fn with_no_active_set_every_client_reads_as_settled() {
        let s = Scratch::new();
        let installed = vec![client("codex", Some(sentinel(s.path("AGENTS.md"))))];
        let reg = crate::registry::Registry::default();
        let rows = status_from(&reg, &installed, None);
        assert_eq!(
            rows[0].state,
            ApplyState::Applied,
            "nothing is meant to be on disk, so nothing is stale"
        );
    }

    // ---- write / status round trip, straight through the instructions engine ----

    #[test]
    fn a_shared_file_keeps_user_bytes_and_reports_applied() {
        let s = Scratch::new();
        let path = s.path("AGENTS.md");
        let user = "# Mine\nAlways run tests.\n";
        std::fs::write(&path, user).unwrap();
        let target = sentinel(path.clone());
        let rules = set("work", 3, "Be brief.");

        assert_eq!(
            instructions::write_target(&target, &rules.id, rules.revision, &rules.content),
            ApplyState::Applied
        );
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.starts_with(user), "user bytes preserved");
        assert!(after.contains("Be brief."));

        let installed = vec![client("codex", Some(target.clone()))];
        let mut reg = crate::registry::Registry::default();
        reg.set_rules_client_enabled("codex", true);
        assert_eq!(
            status_from(&reg, &installed, Some(&rules))[0].state,
            ApplyState::Applied
        );

        // A newer revision of the same set reads as Stale until it is applied.
        let bumped = set("work", 4, "Be brief.");
        assert_eq!(
            status_from(&reg, &installed, Some(&bumped))[0].state,
            ApplyState::Stale
        );
    }

    /// The three cases the SBS-821 acceptance criteria name, per strategy: a fresh file, a file
    /// that already carries our block, and a file with user content and no block.
    #[test]
    fn each_strategy_handles_fresh_existing_block_and_foreign_file() {
        let s = Scratch::new();
        let rules = set("work", 1, "Be brief.");

        // Fresh file.
        let fresh = sentinel(s.path("fresh.md"));
        assert_eq!(
            instructions::write_target(&fresh, &rules.id, rules.revision, &rules.content),
            ApplyState::Applied
        );
        assert!(fresh.path.exists());

        // Already carries our block: idempotent, byte-identical.
        let before = std::fs::read_to_string(&fresh.path).unwrap();
        assert_eq!(
            instructions::write_target(&fresh, &rules.id, rules.revision, &rules.content),
            ApplyState::Applied
        );
        assert_eq!(std::fs::read_to_string(&fresh.path).unwrap(), before);

        // User content, no block: appended to, never replaced.
        let foreign = sentinel(s.path("foreign.md"));
        let user = "# Mine\nkeep me\n";
        std::fs::write(&foreign.path, user).unwrap();
        assert_eq!(
            instructions::write_target(&foreign, &rules.id, rules.revision, &rules.content),
            ApplyState::Applied
        );
        assert!(std::fs::read_to_string(&foreign.path).unwrap().starts_with(user));

        // Owned files are ours whole, and a foreign file at the owned path is never deleted.
        let own = owned(s.path("rules").join(Scope::Personal.owned_file_name()));
        assert_eq!(
            instructions::write_target(&own, &rules.id, rules.revision, &rules.content),
            ApplyState::Applied
        );
        assert!(std::fs::read_to_string(&own.path)
            .unwrap()
            .starts_with(instructions::PERSONAL_OWNED_HEADER_PREFIX));
    }

    // ---- end-to-end apply, against a redirected registry ----
    //
    // These drive `apply_to` for real: it loads and writes the registry, so each holds the
    // process-global data-dir guard and points the registry at a scratch dir. The client targets
    // are synthetic scratch paths, so no real client file on the developer's machine is touched.

    /// Seed the (redirected) registry with one set and the given opted-in clients, then run
    /// `apply_to`. Callers must already hold the data-dir guard and override.
    fn seed_and_apply(content: &str, enabled: &[&str], installed: &[ClientTarget]) -> RulesView {
        crate::registry::update(|reg| {
            reg.upsert_rule_set(Some("work"), "Work", content);
            for id in enabled {
                reg.set_rules_client_enabled(id, true);
            }
            Ok(())
        })
        .expect("seed the registry");
        apply_to(installed).expect("apply")
    }

    #[test]
    fn apply_writes_opted_in_clients_and_records_what_it_wrote() {
        let _dirs = crate::registry::data_dir_test_lock();
        let s = Scratch::new();
        let base = s.path("data");
        let _data_dir = crate::registry::DataDirOverride::set(&base);

        let codex = client("codex", Some(sentinel(s.path("AGENTS.md"))));
        let claude = client(
            "claude-code",
            Some(owned(s.path("rules").join(Scope::Personal.owned_file_name()))),
        );
        let cursor = client("cursor", None);
        let installed = vec![codex.clone(), claude.clone(), cursor.clone()];

        // Only Codex is opted in.
        let view = seed_and_apply("Be brief.", &["codex"], &installed);

        let codex_path = codex.target.clone().unwrap().path;
        let claude_path = claude.target.clone().unwrap().path;
        assert!(codex_path.exists(), "opted-in client is written");
        assert!(!claude_path.exists(), "opted-out client is left alone");

        let reg = crate::registry::load().unwrap();
        assert_eq!(
            reg.rules_targets,
            vec![codex_path.to_string_lossy().to_string()],
            "only the written path is recorded"
        );

        let by_id = |id: &str| view.clients.iter().find(|c| c.id == id).unwrap().clone();
        assert_eq!(by_id("codex").state, ApplyState::Applied);
        assert!(by_id("codex").enabled);
        assert_eq!(by_id("claude-code").state, ApplyState::Stale);
        assert!(!by_id("claude-code").enabled);
        assert_eq!(by_id("cursor").state, ApplyState::Unsupported);
    }

    #[test]
    fn opting_a_client_out_removes_only_that_clients_file() {
        let _dirs = crate::registry::data_dir_test_lock();
        let s = Scratch::new();
        let _data_dir = crate::registry::DataDirOverride::set(s.path("data"));

        let codex = client("codex", Some(sentinel(s.path("AGENTS.md"))));
        let zed = client("zed", Some(sentinel(s.path("zed-AGENTS.md"))));
        let installed = vec![codex.clone(), zed.clone()];
        let codex_path = codex.target.clone().unwrap().path;
        let zed_path = zed.target.clone().unwrap().path;

        // A file the user already owns, so we can prove only our span goes.
        let user = "# Mine\nkeep me\n";
        std::fs::write(&codex_path, user).unwrap();

        seed_and_apply("Be brief.", &["codex", "zed"], &installed);
        assert!(zed_path.exists());
        assert!(std::fs::read_to_string(&codex_path).unwrap().contains("Be brief."));

        crate::registry::update(|reg| {
            reg.set_rules_client_enabled("codex", false);
            Ok(())
        })
        .unwrap();
        apply_to(&installed).unwrap();

        assert_eq!(
            std::fs::read_to_string(&codex_path).unwrap(),
            user,
            "the opted-out client's file is back to the user's own bytes"
        );
        assert!(zed_path.exists(), "the other client is untouched");
        let reg = crate::registry::load().unwrap();
        assert_eq!(reg.rules_targets, vec![zed_path.to_string_lossy().to_string()]);
    }

    #[test]
    fn switching_sets_rewrites_in_place_and_clearing_removes_everything() {
        let _dirs = crate::registry::data_dir_test_lock();
        let s = Scratch::new();
        let _data_dir = crate::registry::DataDirOverride::set(s.path("data"));

        let codex = client("codex", Some(sentinel(s.path("AGENTS.md"))));
        let installed = vec![codex.clone()];
        let path = codex.target.clone().unwrap().path;

        seed_and_apply("Rules A.", &["codex"], &installed);
        assert!(std::fs::read_to_string(&path).unwrap().contains("Rules A."));

        // A second set replaces the first set's span rather than stacking a second block.
        crate::registry::update(|reg| {
            let id = reg.upsert_rule_set(None, "Other", "Rules B.");
            reg.set_active_rule_set(Some(&id));
            Ok(())
        })
        .unwrap();
        apply_to(&installed).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("Rules B."));
        assert!(!after.contains("Rules A."), "the old set's span is replaced, not appended to");
        assert_eq!(
            after.matches(instructions::PERSONAL_SENTINEL_START_PREFIX).count(),
            1,
            "exactly one personal block, whichever set wrote it"
        );

        // Clearing the selection takes our file away and forgets the recorded path.
        crate::registry::update(|reg| {
            reg.set_active_rule_set(None);
            Ok(())
        })
        .unwrap();
        let view = apply_to(&installed).unwrap();
        assert!(!path.exists(), "a file that held only our block is removed");
        let reg = crate::registry::load().unwrap();
        assert!(reg.rules_targets.is_empty(), "nothing left to clean up");
        assert_eq!(
            view.clients[0].state,
            ApplyState::Applied,
            "with no active set there is nothing to be stale about"
        );
    }

    /// Cleanup is by RECORDED path, so opting a client out (or switching sets) removes exactly the
    /// file we wrote and leaves the user's own bytes and any team block alone.
    #[test]
    fn cleanup_removes_only_our_span() {
        let s = Scratch::new();
        let path = s.path("AGENTS.md");
        let user = "# Mine\nkeep me\n";
        std::fs::write(&path, user).unwrap();
        let personal = sentinel(path.clone());
        let team = Target {
            scope: Scope::Team,
            ..sentinel(path.clone())
        };
        instructions::write_target(&team, "team_abc", 1, "Org rule");
        instructions::write_target(&personal, "work", 1, "Be brief.");

        instructions::remove_recorded(&path, Scope::Personal);
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.starts_with(user), "user bytes survive");
        assert!(after.contains("Org rule"), "the team block is not ours to remove");
        assert!(!after.contains("Be brief."), "our span is gone");
    }
}
