# Floway PR #528 Screenshots

Production Web build at `f224f96b59fcd1d5997f300ce8c252d7e8830896`, rendered with synthetic API responses. No real reset card was consumed.

These review artifacts belong to https://github.com/Menci/Floway/pull/528 and are kept outside the product branch.

Screenshots cover the available action, confirmation, pending redemption, success with a disabled Redeemed button, empty list, list failure, redemption failure, expiry, dark theme, and a 390px Simplified Chinese viewport.

`pnpm run verify` passed: 576 test files, 6,200 tests, 63 installer checks passed and 47 host-dependent skips. Type generation, lint, typechecks, repository invariant checks, and production Web build passed.

Browser checks: cancellation sent zero consume requests; success sent one; three retry attempts shared one idempotency key; redeemed action disabled; no page errors, unexpected requests, or mobile horizontal overflow.

![Available card](01-available-light.png)
![Redeemed card](04-success.png)
![Empty list](05-empty.png)
![Chinese mobile](10-mobile-chinese.png)
