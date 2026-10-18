---
name: test-driven-development
description: Write code test-first (red, green, refactor) and prove that modules work together, not only in isolation. Use when implementing a feature, operation, rule or bug fix; when a change crosses a module boundary or touches a flow that spans several modules (an entry point, a write path, a job, a permission check); when choosing which kind of test to write; when reviewing tests for coverage or quality; or when the user asks about TDD, integration tests, contract tests or end-to-end tests.
---

# Test-driven development across module boundaries

Two habits. First, every behaviour change starts as a failing test. Second, a feature is not
proven until a test shows the modules it crosses actually cooperate: the caller, the owner it
calls, the storage underneath and the adapter in front. Unit tests prove a part is right;
connection tests prove the parts fit.

The project's own rules come first. Read its instructions file and the design documents it
points to for the test layers it defines, the commands that run them, the helpers that build
test data and the acceptance criteria of the current task. Where they are explicit, they win.

## 1. The loop: red, green, refactor

1. **Red.** Write the smallest test that states the next rule you need, run it, and watch it
   fail **for the reason you expect** (an assertion, not an import error or a typo). A test
   you never saw fail proves nothing.
2. **Green.** Write the least code that makes it pass. Hard-coding is fine if the next test
   will force the generalisation.
3. **Refactor.** With everything green, clean up names, duplication and structure in both the
   code and the test. Run the suite again. Never refactor on red.

Rules that keep the loop honest:

- **Start from the outside.** For a new feature, first write one failing test at the
  outermost level the task touches (an API call, a command, a user flow). Leave it red, then
  drive the inside with smaller tests until it passes. This keeps the inner work aimed at
  what the caller needs.
- **One rule per test.** Name the test after the rule it proves ("a member cannot see another
  member's private item"), not the function it calls ("getItem works").
- **Bugs start as a test.** Reproduce the defect with a failing test at the lowest level that
  shows it, then fix it. If the bug was a broken connection between modules, the reproducing
  test must cross that connection (section 3).
- **Test behaviour, not implementation.** Assert on what a caller can observe: return values,
  errors, stored state read back through the owner, emitted records. Don't assert on private
  helpers or call order unless the order is the contract.
- **Keep it runnable.** Run the narrowest relevant test project while iterating and the full
  suite before calling the work done. Report failing output as it is; never weaken or skip
  a test to get green.

## 2. Pick the cheapest test that can fail for the right reason

| Question the test answers                                                                      | Kind of test                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Is this pure rule, calculation or mapping correct?                                             | Unit: no I/O, fast, many cases                                      |
| Does storage enforce what it promises (constraints, triggers, row locks)?                      | Integration against the real database                               |
| Does a module's public operation do its whole job, including persistence and side records?     | Integration through the module's public interface                   |
| Do two or more modules cooperate on one flow?                                                  | Cross-module integration (section 3)                                |
| Does an adapter (HTTP, CLI, tool protocol) map input, errors and auth correctly onto the core? | Adapter integration through the real adapter                        |
| Does the published contract match what the code serves?                                        | Contract test: schema, registry or snapshot checks                  |
| Does a user get the result end to end?                                                         | End to end against a running stack; few, covering the main journeys |
| Does a guarantee hold for every combination, not just the ones I thought of?                   | Property or generated tests (randomised data, many seeds)           |

Use the real database for anything that depends on it; mocks of storage test your mock.
Mock only what you do not own and cannot run locally (third-party services, the clock,
randomness), and inject those at the edge.

## 3. Test the connections, not just the modules

A module that passes its own tests can still fail its callers: a field renamed on one side,
an error mapped to the wrong code, a permission checked by the owner but bypassed by a new
path, a transaction that commits one module's write and loses another's. These defects live
**between** modules, so only a test that crosses the boundary catches them.

**Map the flow before you test it.** For the feature at hand, list every module the request
passes through, in order: entry adapter, the owning service, any services it calls, the
platform pieces wrapping the write (context, idempotency, audit, logging), storage, and
anything that reads the result back. Each arrow in that list is a connection to prove.

**Write at least one test per connection the change introduces or alters:**

- **Caller to owner.** Call the operation through the caller's public interface and assert the
  owner's effect is visible through the **owner's** public read, not the caller's assumption
  of it.
- **Write path end to end.** One test that a successful operation produces every record it
  must (the change, its version or history, its audit entry) and one that a failure in any
  step rolls back all of them. Force the failure in the real dependency, not with a stub.
- **Permissions across surfaces.** A rule enforced by its owner must hold through every entry
  point that reaches it. Test the same denial through each adapter the change touches, with
  the real authentication and context wiring, not a hand-built context.
- **Errors across the boundary.** Trigger the owner's error and assert the caller and the
  adapter surface the contract's error code and status, without leaking internals.
- **Shape across the boundary.** Feed the real output of one module into the next. Don't
  hand-write the intermediate value; that hides drift between producer and consumer.
- **Derived state.** When a value is computed from another module's facts, change the source
  through its owner and assert the derived value follows.
- **Isolation and leaks.** For anything private or scoped, build several actors and assert
  nothing crosses: one actor's data never appears in another's reads, lists, counts, errors
  or timings that reveal it.

**Rules for connection tests:**

- **Go through public interfaces only.** A connection test calls the same entry points real
  callers use. Reaching into another module's internals or tables to arrange or assert hides
  exactly the breakage you are looking for. Building the starting world directly in storage
  with the project's fixtures is fine, provided the write path under test is then exercised
  for real.
- **Wire it the way production does.** Construct modules with the same composition the
  application uses (same factories, same platform wrappers), against the real database.
  A connection test with a fake in the middle tests nothing between the real pieces.
- **Arrange with factories, act through the system, assert through the owner.**
- **Cover the unhappy connections.** Denied access, missing or deleted targets, conflicting
  concurrent writes, retries with the same idempotency key, partial failure mid-flow.
- **Keep them focused.** One flow, one rule per test. Several narrow connection tests beat one
  long scenario that fails without saying where.
- **Keep end-to-end tests few.** They prove the stack is wired and the main journeys work;
  rules and edge cases belong lower, where failures are cheap and specific.

## 4. Before calling the work done

- Every rule in the task's acceptance criteria maps to a named test, and each test was seen
  failing before the code that passes it.
- Every module boundary the change crosses has a test that crosses it, through public
  interfaces, against real infrastructure.
- Every entry point that reaches the changed behaviour has at least one test through that
  entry point, including one denial.
- The full suite passes locally with the project's commands; nothing skipped, focused or
  weakened.
- The work's summary lists, for each acceptance criterion, the test name or command that
  proves it.

## How to use this skill

**When implementing:** map the flow (section 3), write the outermost failing test, then loop
red-green-refactor inward (section 1), choosing each test's level with section 2. Finish with
the checklist in section 4.

**When reviewing tests:** report only findings that would change the tests, each as

```
<file>:<line> — <gap>: <what is unproven or wrong> → <test to add or change>
```

ordered by impact: an untested connection or entry point first, then a test that can't fail
for the right reason (mocked storage, hand-built intermediate values, asserting on
internals), then missing unhappy paths, then naming and readability.
