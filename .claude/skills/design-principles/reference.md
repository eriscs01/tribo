# Research notes: clean code, SRP and OCP

Background for [SKILL.md](SKILL.md): where each principle comes from, how its meaning shifted,
and the strongest criticism. Summaries, not quotations, except where marked.

## Single Responsibility Principle

- **Origin.** Robert C. Martin, early 2000s (_Agile Software Development: Principles,
  Patterns, and Practices_, 2002), building on Parnas's information hiding (1972) and the
  cohesion work of Constantine and DeMarco. First wording: a class should have only one
  reason to change.
- **Clarification.** "Reason" proved ambiguous, so Martin restated it in his 2014 blog post
  "The Single Responsibility Principle": gather together things that change for the same
  reasons, separate things that change for different reasons.
- **Final form.** In _Clean Architecture_ (2017): a module should be responsible to one, and
  only one, _actor_, a group of stakeholders who would ask for the change. Martin explicitly
  says SRP is not "every module should do one thing"; that is a function-level heuristic.
- **Why it matters.** When two actors share code, a change for one breaks the other, and
  merges collide. Separating by actor localises change.
- **Criticism.** "Responsibility" and "actor" are still judgment calls; applied mechanically
  it produces many tiny classes ("classitis", Ousterhout) and spreads one idea across files.
  The useful test is whether two parts actually change at different times for different people.
- **In practice.** "Single source of truth" and module ownership rules are SRP applied to
  data and rules: each fact and each rule has one owning module and one place it is enforced.

## Open-Closed Principle

- **Origin.** Bertrand Meyer, _Object-Oriented Software Construction_ (1988): modules should
  be open for extension and closed for modification. Meyer's mechanism was implementation
  inheritance: once a module is published and others depend on it, leave it alone and derive
  a new one.
- **Polymorphic reading.** Martin's 1996 article "The Open-Closed Principle" (C++ Report)
  moved it to abstract interfaces: depend on a stable abstraction; new behaviour is a new
  implementation. This is the version SOLID popularised.
- **Protected Variation.** Cockburn (1996) and Larman framed the same idea as: identify points
  of predicted variation or instability and assign responsibilities to create a stable
  interface around them. Larman's IEEE Software column (2001, hosted on martinfowler.com)
  treats OCP and PV as two expressions of one principle. The key word is _predicted_: protect where change is expected, not everywhere.
- **Criticism.** Jon Skeet (2013) argued the slogan does more harm than good: you cannot close
  code against changes you didn't foresee, and in-house code you own is often best simply
  edited. Martin conceded the slogan was overstated while defending the full article. Premature
  abstraction (YAGNI, the "rule of three") is the common failure mode.
- **In practice.** Registries, declarative definitions, append-only migrations and versioned
  contracts are common designed extension points. Closed unions (error codes, states) are
  intentionally closed: adding a member should break the build until every handler is updated.

## Clean code

- **Origin.** Robert C. Martin, _Clean Code_ (2008): meaningful names, small functions that do
  one thing, few arguments, no side effects, command-query separation, comments as a last
  resort, error handling with exceptions, the Boy Scout rule, tests as first-class code.
  Precedents: Kernighan & Plauger, _The Elements of Programming Style_ (1974); Beck's simple
  design rules; Fowler's _Refactoring_ (1999) code smells.
- **Durable parts.** Intention-revealing names, consistent vocabulary, small interfaces,
  explicit error handling, tests that read as specifications, leaving code cleaner than you
  found it.
- **Criticism.** The advice to keep functions to a few lines optimises a proxy (line count)
  rather than comprehension, and can scatter logic so readers jump between many shallow
  helpers. John Ousterhout's _A Philosophy of Software Design_ (2018) argues complexity is what
  matters: prefer deep modules with simple interfaces, pull complexity downward, and accept
  longer functions when they read clearly. Some of _Clean Code_'s Java examples are also
  widely considered dated.
- **In practice.** Use the domain's vocabulary, keep module interfaces small and their
  implementations deep, push invariants into types, schemas and constraints, and judge any
  extraction by whether it lowers the reader's load.

## Sources

- [Single-responsibility principle (Wikipedia)](https://en.wikipedia.org/wiki/Single-responsibility_principle)
- [Single Responsibility Principle (DevIQ)](https://deviq.com/principles/single-responsibility-principle/)
- [Open–closed principle (Wikipedia)](https://en.wikipedia.org/wiki/Open%E2%80%93closed_principle)
- [Protected Variation, Craig Larman (IEEE Software, via martinfowler.com)](https://martinfowler.com/ieeeSoftware/protectedVariation.pdf)
- [Jon Skeet's blog, March 2013 (OCP critique)](https://codeblog.jonskeet.uk/2013/03/)
- [Open-Closed Principle challenged (InfoQ)](https://www.infoq.com/news/2013/05/open-closed-principle-challenged)
- [Book notes: A Philosophy of Software Design (Dan Lebrero)](https://danlebrero.com/2021/02/24/philosophy-of-software-design-summary/)
- [On Object-Oriented Programming and Clean Code](https://lr0.org/blog/p/ccoop)
