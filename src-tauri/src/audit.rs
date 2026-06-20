//! Tool-call audit log.
//!
//! Every tool call routed through the gateway is appended here as one JSON line.
//! This is the artifact the governance/MSP story is built on: a record of which
//! AI tool invoked which server's tool, and when. Local and append-only.

use std::io::Write;
use std::path::PathBuf;

use serde_json::{json, Value};

pub fn audit_path() -> Option<PathBuf> {
    // Same anchor as the registry, so the app and a client-spawned gateway (which
    // may run under MSIX virtualization) write to the *same* audit log.
    Some(crate::registry::conduit_dir()?.join("audit.jsonl"))
}

fn epoch_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Append one tool-call record. Best-effort: never fails the call it's logging.
pub fn record(server: &str, tool: &str, ok: bool) {
    record_timed(server, tool, ok, None)
}

/// Append a tool-call record including how long the call took. Powers the
/// in-app latency/error-rate dashboard.
pub fn record_timed(server: &str, tool: &str, ok: bool, duration_ms: Option<u64>) {
    let mut entry = json!({
        "ts": epoch_millis() as u64,
        "server": server,
        "tool": tool,
        "ok": ok,
    });
    if let Some(ms) = duration_ms {
        entry["durationMs"] = json!(ms);
    }
    if let Some(path) = audit_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "{entry}");
        }
    }
}

/// The most recent `limit` entries, newest first.
pub fn read_recent(limit: usize) -> Vec<Value> {
    let path = match audit_path() {
        Some(p) => p,
        None => return Vec::new(),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<Value> = content
        .lines()
        .rev()
        .take(limit)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    // `rev().take()` gives newest-first already.
    entries.truncate(limit);
    entries
}

/// Average and 95th-percentile of a duration sample, in ms. `None` when the
/// sample is empty (e.g. older records logged before latency was tracked).
fn latency(durs: &mut [u64]) -> (Option<u64>, Option<u64>) {
    if durs.is_empty() {
        return (None, None);
    }
    let sum: u64 = durs.iter().sum();
    let avg = sum / durs.len() as u64;
    durs.sort_unstable();
    // Nearest-rank p95.
    let idx = (((durs.len() as f64) * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(durs.len() - 1);
    (Some(avg), Some(durs[idx]))
}

/// Aggregate the last `window` calls into per-server stats plus global totals.
/// This is the data behind the observability dashboard: call volume, error
/// rate, and latency per server, computed locally from the audit log.
pub fn stats(window: usize) -> Value {
    use std::collections::HashMap;

    #[derive(Default)]
    struct Agg {
        calls: u64,
        errors: u64,
        durs: Vec<u64>,
        last_ts: u64,
    }

    let entries = read_recent(window);
    let mut by_server: HashMap<String, Agg> = HashMap::new();
    let mut total = 0u64;
    let mut errors = 0u64;

    for e in &entries {
        let server = e.get("server").and_then(|v| v.as_str()).unwrap_or("?");
        let ok = e.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
        let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        let dur = e.get("durationMs").and_then(|v| v.as_u64());

        total += 1;
        if !ok {
            errors += 1;
        }
        let a = by_server.entry(server.to_string()).or_default();
        a.calls += 1;
        if !ok {
            a.errors += 1;
        }
        if let Some(d) = dur {
            a.durs.push(d);
        }
        a.last_ts = a.last_ts.max(ts);
    }

    let mut servers: Vec<Value> = by_server
        .into_iter()
        .map(|(server, mut a)| {
            let (avg, p95) = latency(&mut a.durs);
            json!({
                "server": server,
                "calls": a.calls,
                "errors": a.errors,
                "errorRate": if a.calls > 0 { a.errors as f64 / a.calls as f64 } else { 0.0 },
                "avgMs": avg,
                "p95Ms": p95,
                "lastTs": a.last_ts,
            })
        })
        .collect();
    // Busiest servers first.
    servers.sort_by(|x, y| {
        y.get("calls")
            .and_then(|v| v.as_u64())
            .cmp(&x.get("calls").and_then(|v| v.as_u64()))
    });

    json!({
        "total": total,
        "errors": errors,
        "errorRate": if total > 0 { errors as f64 / total as f64 } else { 0.0 },
        "servers": servers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latency_avg_and_p95() {
        let mut d = vec![10u64, 20, 30, 40, 100];
        let (avg, p95) = latency(&mut d);
        assert_eq!(avg, Some(40)); // (10+20+30+40+100)/5
        assert_eq!(p95, Some(100)); // nearest-rank p95 of 5 samples = last
        let (a, p) = latency(&mut []);
        assert_eq!((a, p), (None, None));
    }
}
