---
module: space-bus
category: security-issues
date: 2026-07-11
problem_type: security_issue
component: tooling
severity: high
symptoms:
  - CodeQL flagged js/file-system-race (high) on a log-hardening path
  - a symlinked log target could be swapped between the symlink check and the open
root_cause: missing_validation
resolution_type: code_fix
tags:
  - launchd
  - symlink
  - toctou
  - file-system-race
  - o-nofollow
  - fchmod
  - codeql
---

# A security-hardening fix can introduce a TOCTOU: atomic open over check-then-use

## Problem

A ce:review finding asked `space-bus service` to harden its log files: they must be `0600`, and the code must refuse a **symlinked** log path (so an install can't be tricked into writing through a symlink to an attacker-chosen target). The fix that satisfied the finding introduced a *new* security bug: it used `lstatSync(path)` to detect a symlink, **then** `openSync(path, "a")` — a classic time-of-check-to-time-of-use (TOCTOU) race. CodeQL caught it as `js/file-system-race` (high).

## Symptoms

- CodeQL check-run on the PR: **"1 new alert including 1 high severity security vulnerability"**, rule `js/file-system-race` at `src/service.ts`, message *"The file may have changed since it was checked."*
- The offending shape: an `lstat` (check) and an `open` (use) against the same path, with a window in between during which an attacker could replace a regular file with a symlink.

## What Didn't Work

The intuitive "hardening" was itself the vulnerability. Checking-then-using is the trap: any gap between "I verified this path is safe" and "I acted on this path" is exploitable if the path lives in a directory another principal can write. Adding *more* checks doesn't close it — the race is structural.

## Solution

Eliminate the check entirely. Open **atomically** with `O_NOFOLLOW` so the kernel refuses a symlinked final component *at open time*, and harden the mode on the returned **file descriptor** (`fchmod`), never by re-resolving the path:

```ts
function preCreateLog(path: string): PreCreateLogResult {
  // Open atomically with O_NOFOLLOW so the kernel refuses a symlink at the
  // path (no separate lstat check-then-open — that's a TOCTOU race). O_APPEND
  // preserves an existing log; O_CREAT makes it when absent. Harden the mode
  // via the open fd (fchmod), never by re-resolving the path.
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if (isSymlinkError(err)) {
      return { ok: false, error: `refusing symlinked log path: ${path}` };
    }
    return { ok: false, error: `failed to create log ${path}: ${String(err)}` };
  }
  try {
    fchmodSync(fd, 0o600);
  } catch (err) {
    return { ok: false, error: `failed to chmod log ${path}: ${String(err)}` };
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

// O_NOFOLLOW raises ELOOP when the final path component is a symlink;
// map it to the "refusing symlink" result rather than a generic IO error.
function isSymlinkError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err &&
    (err as { code?: string }).code === "ELOOP"
  );
}
```

The pre-fix shape was `lstatSync(path)` → check `isSymbolicLink()` → `openSync(path, "a", 0o600)` → `chmodSync(path, 0o600)` — three separate path resolutions, two of them races.

## Why This Works

`O_NOFOLLOW` makes the symlink rejection **atomic with the open** — there is no window between check and use because there is no separate check. `fchmod(fd)` operates on the already-open descriptor, so it can't be redirected to a different inode by a path swap. The kernel does the enforcement, at the one instant it matters.

## Prevention

- **Never `stat`-then-`open` (or `access`-then-`open`, or `readlink`-then-`open`) on a path in a directory another principal can write.** Open atomically and inspect the resulting fd.
- For "must not be a symlink" requirements, use `O_NOFOLLOW` and map `ELOOP` to your refusal path.
- For "must have mode X" requirements, `fchmod`/`fstat` the fd, not the path.
- Treat a security-hardening change as security-relevant code in its own right — run the scanner on it. This finding was caught only because CodeQL runs on every PR; the fix that created it had passed 7-persona + Oracle review without anyone spotting the race.

## Related

- [../best-practices/launchd-ambient-env-plist-pinning-2026-07-11.md](../best-practices/launchd-ambient-env-plist-pinning-2026-07-11.md) — a sibling hardening lesson from the same `space-bus service` feature.
- [../best-practices/verify-reviewer-empirical-claims-2026-07-05.md](../best-practices/verify-reviewer-empirical-claims-2026-07-05.md) — the CodeQL alert was the empirical arbiter here; the fix was verified against the re-scan, not assumed.
