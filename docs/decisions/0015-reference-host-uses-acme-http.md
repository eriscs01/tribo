# 0015. The reference host uses acme-http

- Date: 23 Oct 2026
- Status: accepted
- Source: v0.3.0 fresh install of the reference host (orchestrator and operator)

## Context

The reference host was rebuilt from scratch for v0.3.0. Its TLS mode could be `acme-dns-cloudflare`, where Caddy proves control of the name through Cloudflare's DNS API, or `acme-http`, where Let's Encrypt reaches the host on ports 80 and 443. The DNS mode needs a Cloudflare API token with DNS edit rights in `secrets/cloudflare_api_token` on the server: anyone who takes the host also gets a credential that can change the zone's records. The Cloud Firewall and ufw already admit 80 and 443 from anywhere (runbook step 3), and the record is DNS only, so HTTP-01 and TLS-ALPN-01 work as they are.

## Decision

The reference host runs `TRIBO_TLS_MODE=acme-http`, with no Cloudflare credential on the server. Ports 80 and 443 stay open to all in both firewalls, and the CAA record limits issuance to `letsencrypt.org`.

## Consequences

A compromised host cannot change DNS. Renewal depends on 80 or 443 being reachable from Let's Encrypt, so closing them (for example for a Cloudflare Tunnel) needs a change of mode first. A wildcard certificate or a host behind a firewall that admits no public traffic would need `acme-dns-cloudflare` and its token.
