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

This repository ships the pure-JavaScript fallback only. The optional N-API addon is
built from a separate Rust workspace this repository does not carry, and is loaded only
from `packvium-native.node` beside `index.js`; no npm package is probed, so nothing is
installed automatically and nothing has to resolve. When no addon loads at `require()` time,
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

## How your feedback is handled

Every issue and discussion is read by a maintainer. This is what happens next:

1. **New issues are labelled `needs-triage`.** A maintainer answers with one of: a question
   back to you, a confirmation, or a reason it will not be taken on.
2. **A confirmed bug** gets the `bug` label and is reproduced from your request. A wrong result
   in one package is checked against the others, because all of them implement the same
   contract and must agree.
3. **An accepted feature request or idea** is added to the project's backlog, and the issue is
   labelled `accepted` with a comment saying so. An idea from Discussions is first turned into
   an issue and linked back to the discussion.
4. **When the change ships**, the issue is closed with the release it shipped in. A change to
   the request or result format can only ship in a release that is allowed to change it, so
   it may take more than one release.
5. **Declined** requests are closed with the reason, so you are never left waiting on a
   silent issue.

Questions go to **Discussions → Q&A**; security problems go to **Report a vulnerability**
under the Security tab, never to a public issue.
