# U1 listener-identity feasibility probe (diagnostic, not production U4)

Question: can an **unprivileged** process correlate a loopback TCP listener it
created to the process that owns it, on macOS and Linux, failing closed on
everything else?

```sh
bun test/fixtures/dual-host/listener/probe.ts   # exit 0 only if all expectations hold
```

- **macOS:** `lsof -nP -a -iTCP:<port> -sTCP:LISTEN -Fpn` (own-user processes).
- **Linux:** `/proc/net/tcp{,6}` LISTEN rows -> socket inode -> `/proc/<pid>/fd/*`
  `socket:[inode]` links (own-user processes; no external tool).
- Fails closed: `no-listener`, `wrong-pid`, `ambiguous` (more than one owning
  process), `non-loopback` (wildcard/LAN bind), `uninspectable`, `timeout`,
  `error` (tool missing, bad exit, unparseable output), `unsupported-platform`.

The probe only ever spawns its **own** child (`child-listener.mjs`) bound to
`127.0.0.1:<OS-assigned port>`. It never connects to that port, sends data,
scans, or touches credentials or any real OpenCode. Synthetic sections
(`synthetic lsof`, `synthetic /proc`) exercise the classification logic on any
OS and are **not** OS verification; only the `live on <os>` section is.

## Running on Linux (portable instructions)

Run in an isolated, unprivileged environment you are already authorized to use
(a container or VM user, not root; this lane did not create one):

```sh
bun --version            # need bun; `node` is optional (live ambiguity control)
bun test/fixtures/dual-host/listener/probe.ts; echo "exit=$?"
```

Record `uname -a`, `/etc/os-release`, bun/node versions, the full output and the
exit status. Also record: `cat /proc/sys/kernel/yama/ptrace_scope` and whether
`/proc` is mounted with `hidepid` (`mount | grep ' /proc '`); `hidepid=1|2`
hides other users' fd tables, which is fine for same-user services but is the
reason the `uninspectable` case exists. Expected: `== 35/35 expectations held; PASS`
(the live ambiguity control is skipped, not failed, if `node` is absent).

## Limits (read before relying on this)

- **Check-to-connect race.** The answer is a snapshot. The listener can exit and
  another process can bind the same port between inspection and a later connect
  (pid and port reuse). This is not connection-bound authentication.
- Same-user visibility only: a listener owned by another user is
  `no-listener`/`uninspectable` to an unprivileged process; that is a failure by
  design.
- TCP, loopback (`127.0.0.1`, `::1`) only. A wildcard or LAN bind on the same
  port is refused as `non-loopback`, even if a loopback listener also exists.
- "Ambiguous" includes legitimate fork-inherited sockets (two processes hold one
  listener); U4 would need a decision if the service does that.
- macOS depends on `/usr/sbin/lsof` (revision 4.91 here); other lsof builds may
  differ in `-F` output. Linux depends on a readable, non-`hidepid` `/proc`.
- The `lsof`/`/proc` scan reads local kernel tables only; no network I/O.
