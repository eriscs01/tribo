# 0008. Rate limits: what counts, against whom, and which client address is believed

- Date: 22 Oct 2026
- Status: accepted
- Source: security package S1 (branch `1a/security`)

## Context

The Technical design (Operations, "Rate limits") asks for in-memory limits in the app: login
lockout per username, 10 logins a minute per IP, and one write limit of 120 a minute per user or
OAuth client, answered with `429 rate_limited` and `Retry-After`. Only the lockout was built. The
design leaves open which operations count as writes, what an account-less write counts against,
whether reads are limited, how the window works, and how the app learns the client's address
behind Caddy without letting a client pick its own bucket.

## Decision

- **What counts.** Every implemented write (any method but GET) is counted; reads are never
  limited. The design limits writes only, every read needs a session, and the polled reads (the
  dashboard, the offline bundle) must not be throttled by their own polling. A planned operation
  answers 501 and is not counted. The rule is `isRateLimited` in `@tribo/contract`, which the REST
  adapter applies and the OpenAPI document declares as a `429` response with `Retry-After`.
- **Against whom.** A write by a signed-in caller counts against the account (120 a minute). A
  write without one counts against the client address (10 a minute): that is `auth.login`, and
  also the other public writes (`auth.passwordReset` today, an anonymous `invites.accept` in
  P7), which run Argon2id just as login does. In 1b an OAuth client gets its own key in the
  accounts' budget. The per-username lockout stays where it is, in identity.
- **Window.** A fixed one-minute window aligned to the clock, per budget. A window's counts are
  dropped whole when the next one starts, so memory holds only the keys seen in the current
  minute; a burst across a boundary can reach twice the budget, which the design's numbers
  tolerate. The clock is injected (`createRateLimits(now)`), so tests move time. `Retry-After`
  is the whole seconds left in the window. Counts are per process and reset on restart.
- **Which client address.** The app uses Fastify's `request.ip` under its existing trust rule
  (`TRIBO_APP_TRUSTED_PROXIES`, default `loopback,uniquelocal`, the Caddy container on the private
  Compose network): `X-Forwarded-For` is read only when the TCP peer is a trusted proxy, and then
  only its right-most untrusted entry, the one the proxy added. A peer that is not trusted is
  counted by its socket address whatever it sends. Caddy in turn takes the client from its own
  `trusted_proxies` rules (Cloudflare's `CF-Connecting-IP`, or a CIDR list) and overwrites
  `X-Forwarded-For` with that one address, so a client's forged header never reaches the app.
- **IPv6.** An IPv6 address counts by its /64, the smallest prefix one subscriber is usually
  given; an IPv4-mapped IPv6 address counts as its IPv4 address.

## Consequences

- A new write operation is limited as soon as it is implemented, with no handler code.
- Users behind one NAT or one IPv6 /64 share the 10-a-minute budget for signing in.
- If the app's trusted proxies do not cover Caddy, every request looks like it comes from
  Caddy's address and sign-ins are limited site-wide; the runbook says how to spot it.
- More than one app process would need a shared store; the design runs one.
- Log lines for a refusal name the operation and `rate_limited`, never the address or username.
