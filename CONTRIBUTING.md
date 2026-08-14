# Contributing

Thanks for looking. This package is small and deliberately strict about determinism —
please keep it that way.

## Getting set up

```bash
npm test
```

No install step: the package has no dependencies, and the test suite runs directly
against the JavaScript fallback (there is no prebuilt native addon in this repository —
see "Native backend" below).

## The rules that matter here

**The fallback is the reference, not a placeholder.** `fallback.js` is a complete,
independent implementation, not a stub that happens to work on easy inputs. It is what
every user gets when the native addon is not present, so it is held to the same
determinism and correctness bar as the Python, PHP and Rust implementations.

**No floats in geometry or feasibility.** JavaScript's only numeric type is a double, so
this matters more here than anywhere else. Coordinates, weights and volumes are tracked
as `BigInt` ticks; if a change routes a placement decision through `Number` arithmetic,
it is wrong even if the tests pass — see
[docs/UNITS-AND-NUMERICS.md](docs/UNITS-AND-NUMERICS.md).

**The native addon and the fallback must agree.** `backend()`, `pack()` and
`rebalanceWeight()` dispatch to whichever is present; a caller must never be able to
tell which one actually ran except by calling `backend()`. A behavioural difference
between them is a bug in whichever one is wrong, not a documented quirk.

**Determinism.** The same input and seed must produce the same output. Avoid iterating
`Object`/`Map` in an order that can reach a result without sorting explicitly first.

**Every fixed defect gets a regression test.** Not "a test somewhere" — a test that
fails before your fix and passes after.

## Behavioural changes

This package is one of four independent implementations of the same documented
contract; the Python, PHP and Rust ports must produce identical placements for the same
request. A change to solver behaviour, the objective vector, serialization field names
or status semantics is a **cross-language change** — open an issue describing it before
writing code, so the other implementations move with it. A change confined to this
package's internals (typing, refactoring, performance without a change in output) is
local and needs no coordination.

## Native backend

This repository ships the pure-JavaScript fallback only. The optional N-API addon comes
from `@packvium/native`, an `optionalDependencies` entry built from a separate Rust
workspace this repository does not carry — npm installs whichever of its per-platform
sub-packages matches your OS/arch, or skips it entirely on an unsupported one, without
failing your install either way. When it is not resolvable at `require()` time,
`backend()` reports `'javascript'` and every call runs the fallback above. Treat the
native path as best-effort acceleration, not a dependency to code against.

## Pull requests

- One logical change per pull request.
- Commit messages in imperative mood, under 72 characters:
  `type(scope): description` with `feat`, `fix`, `refactor`, `chore`, `docs` or `test`.
- Add or update tests. `npm test` must pass on Node 18, 20 and 22.
- Update the relevant document under `docs/` when you change behaviour.
- Do not bump the version; releases are cut separately.

## Reporting a bug

Please include the full request that reproduces it — items, containers and configuration
— and what you expected instead. A packing bug is nearly impossible to act on without
the exact input.

For anything with security implications, follow [SECURITY.md](SECURITY.md) rather than
opening a public issue.
