---
name: design-principles
description: Apply clean code, the Single Responsibility Principle and the Open-Closed Principle. Use when deciding where new logic belongs; when splitting or merging a module, file or function; when adding a new case to an existing mechanism (a new operation, error code, kind, job or command); when reviewing code for design quality; or when the user asks about clean code, SRP, OCP, SOLID, refactoring or code quality.
---

# Design principles

Three principles, read the way their authors meant them. The research behind each, with
sources and the main criticisms, is in [reference.md](reference.md); read it when you need to
justify or explain a call.

The project's own rules come first. Before applying anything here, read the project's
instructions file and the design documents it points to: they say who owns what, which
boundaries are enforced and what the current task's scope is. Where they are explicit, they
win. These principles explain why such rules exist and guide the choices they leave open.

## 1. Single Responsibility: one owner per reason to change

Martin's working definition is "a module should be responsible to one, and only one, actor":
gather what changes for the same reason, separate what changes for different reasons. It is
**not** "a function does one thing"; that is a clean-code heuristic (section 3).

Typical reasons to change, each of which deserves its own home:

- the business rules of one domain concept
- who may do what (permissions, visibility, lifecycle)
- how data is stored and queried
- what the storage itself guarantees (types, constraints, keys)
- the shape of the public contract (API schemas, messages)
- how a transport or interface speaks (HTTP, CLI, UI, tool protocols)
- cross-cutting infrastructure (request context, logging, retries, rate limits, crypto)

Checks when writing or reviewing:

- **Name the actor.** For each file or function you touch, say who would ask for it to change.
  Two different answers (for example "the access rules" and "the error format") mean two
  homes.
- **One rule, one place.** A rule is enforced once, by its owner. If you are about to check it
  again in a handler, a query or the client, call the owner instead. A client may pre-validate
  for user experience only when the owner still decides.
- **No copied facts.** Derived state is computed from its source, not stored or cached in a
  second place that can drift.
- **Adapters translate, they don't decide.** An entry point parses input, calls one domain
  operation and maps the result; a business `if` in an adapter belongs in the domain.
- **Respect the project's layering.** If the project already splits a module by concern
  (for example orchestration, access rules, storage), that split is the sanctioned one.
  Splitting further by technique (`validators`, `helpers`, `utils`) does not separate actors;
  it scatters one. Split only along a different reason to change.
- **Cross boundaries through the owner's public interface**, never by reaching into its
  internals or its data directly. Test fixtures that build a world straight in storage are
  the exception, provided they are never used to test the write path they bypass.

## 2. Open-Closed: add the new case, don't edit the mechanism

Meyer (1988) meant a published module stays closed to edits while staying usable as a base
for new ones. Martin (1996) recast it as depending on a stable abstraction so new behaviour is
new code. Larman (2001) ties it to _Protected Variation_: find the points you **predict** will
vary and put a stable interface around them, and only those.

- **Find the existing extension point first.** Registries, plugin tables, declarative
  definitions, append-only migrations and versioned contracts exist so that a new case is an
  addition. Use them; don't add a case-specific branch to the machinery that consumes them.
- **Generators must stay rerunnable.** If code is generated from a source of truth, keep the
  generated part and the hand-written part separable so a regeneration never destroys or
  blocks on hand edits. A generator that can only run once is a closed mechanism.
- **Is this a predicted variation?** Add an abstraction (an interface, a table of handlers, a
  strategy) only when the design or a second real case shows the point varies. One case is
  not a pattern; write it plainly and refactor when the second arrives.
- **Look for the switch that keeps growing.** A function you must edit for every new kind
  (an `if (kind === …)` chain) wants a registry or a map keyed by that kind, owned by whoever
  defines the kinds.
- **Deliberately closed sets are not violations.** A closed union of error codes, states or
  modes is meant to be exhaustive: adding a member is a contract change, and the compiler
  should flag every place that handles it (exhaustive switches, `never` checks, `satisfies`).
  Don't hide such sets behind a plugin interface. When a set has to exist in several layers
  (a storage constraint, a schema, a type), give it one owner and derive the others from it,
  or test that every copy matches; the compiler can't see a constraint that lives elsewhere.
- **Prefer additive change at published boundaries.** Stored schemas, public APIs and wire
  formats grow by addition; a breaking change is a decision, not a refactor. Choose
  representations that can widen without rewriting (for example constrained text over
  database enums when migrations must add values).
- **Extend at the edge, not the core.** New transports, jobs or commands plug into the core's
  interfaces; the core never imports them.

## 3. Clean code: readable by the next person

Martin's _Clean Code_ heuristics are useful defaults, not laws. Ousterhout's _A Philosophy of
Software Design_ is the counterweight: prefer **deep modules** (simple interface, substantial
implementation) over many shallow ones, and judge code by how hard it is to understand and
change, not by line counts.

- **Names carry the design.** Use the project's domain vocabulary consistently, the same word
  for the same concept everywhere. A name you cannot make precise is a sign the responsibility
  is unclear (section 1).
- **Functions** are as long as one coherent idea. Extract when a block has its own name and
  reason to change, or is reused; don't extract tiny helpers that force the reader to jump.
  Keep parameter lists short; pass a typed object once positional arguments stop being
  obvious at the call site or two of the same type could be swapped.
- **Interfaces small, implementations deep.** A module exposes few operations with clear
  contracts; complexity (transactions, retries, bookkeeping) lives behind them, not in
  callers.
- **Make illegal states unrepresentable.** Validate at the boundary with schemas, use typed
  identifiers, push single-record invariants into storage constraints, prefer discriminated
  unions over combinations of optional fields.
- **Errors are part of the contract.** At a trust boundary, fail with the project's defined
  error types or codes and never leak internal messages or stack traces. Inside the process,
  startup and programmer errors (bad config, a malformed definition) should fail fast with a
  specific, named error; they are not part of the public contract.
- **Comments say why**, or state a contract the type can't. Match the surrounding density;
  don't narrate what the code says.
- **No dead code, no speculative generality**, no commented-out blocks. Stay inside the task.
- **Tests read as specifications.** Name the rule being proven, build data with the project's
  test helpers, keep fast tests free of I/O.
- **Match the surrounding code.** Follow the idioms, structure and style already in use
  before introducing a new one.

## How to use this skill

**When writing code:** before adding a file or function, name its actor (section 1); before
editing a shared mechanism, look for the extension point (section 2); then write it plainly
(section 3).

**When reviewing:** report only findings that would change the code, each as

```
<file>:<line> — <principle>: <what is wrong> → <concrete change>
```

ordered by impact: a rule enforced in two places or a fact stored twice first, then an
adapter making decisions, then a mechanism that needs editing per case, then readability. Say
explicitly when a candidate finding is a deliberate closed set or a one-case abstraction you
recommend _not_ adding. Don't propose refactors outside the current task's scope; note them as
follow-ups instead.
