---
---

Test-only: de-flake the SIGKILL-escalation test by awaiting process death (`waitUntilDead`) instead of asserting `isAlive` instantly, removing a zombie-reap race that failed ~33% in isolation. No runtime change.
