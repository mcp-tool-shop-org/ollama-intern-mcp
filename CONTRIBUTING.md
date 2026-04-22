# Contributing

Thanks for looking. This repo is small and opinionated — the 28-tool surface is frozen, so most contributions are bug fixes, docs, or internals work.

## Reporting bugs

- **Regular bugs** — open an issue on [GitHub Issues](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/issues). Include the failing tool name, the envelope from the call, and your `hardware_profile`.
- **Security bugs** — do **not** open a public issue. See [SECURITY.md](./SECURITY.md) — open a private GitHub security advisory instead.

## Submitting a PR

1. Fork `mcp-tool-shop-org/ollama-intern-mcp`.
2. Branch off `main`.
3. Make the change. Tests ship with code — if you touch behavior, add a test.
4. Run `npm run verify` locally (see below). It must pass.
5. Open a PR against `main`. CI must be green before review.

The 28-tool surface is frozen. PRs that add new tools or reshape existing tool schemas will be closed. Internals, bug fixes, docs, new hardware profiles, and new tier envelopes inside existing tools are all welcome.

## Development setup

```bash
npm install
npm test           # vitest run
npm run verify     # typecheck + build + tests — what CI runs
```

You'll also need a local [Ollama](https://ollama.com) with the tier models pulled (see README → Model pulls). Tests that hit the model are gated; the default suite is fast and pure.

## Code style

- **TypeScript strict.** `tsc --noEmit` must be clean.
- **Structured errors.** Throw `InternError` (see `src/errors.ts`) — never raw `Error`. Every error has a stable `code`, a human `message`, and a `hint`. No stack traces leak through tool results.
- **Tests ship with code.** A PR that changes behavior without a test will not be merged.
- **No telemetry, no cloud calls.** The only network egress is to the local Ollama endpoint. Keep it that way.
- **Envelope is the audit trail.** Every tool returns the same envelope shape — don't skip fields, don't invent new ones outside the tier plumbing.

## Deeper docs

The [handbook](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/) has the full picture — envelope & tiers, laws, artifacts, Hermes integration, troubleshooting.
