# Can I drive ollama-intern-mcp with `curl`?

**No — not directly.** MCP is JSON-RPC 2.0 framed as **newline-delimited JSON over stdin/stdout**, not HTTP. There's no HTTP listener for `curl` to hit.

If you think you want `curl`, you probably want one of:

## If you want to poke at the tool surface by hand

Use the Node.js example — it's the closest thing to `curl`:

```bash
node examples/simple-client-node.js
```

It spawns the server, lists tools, calls one, and prints the envelope. Copy-paste from there.

## If you want to drive the server from a non-Claude agent

See [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) — the reference integration uses Nous Research's Hermes Agent on `hermes3:8b`, which speaks MCP natively and exposes the same stdio contract the Node and Python examples use.

## If you want to test Ollama itself

That **is** an HTTP API, and `curl` works:

```bash
# Is Ollama up?
curl http://127.0.0.1:11434/api/tags

# What models are resident (drives envelope.residency)?
curl http://127.0.0.1:11434/api/ps
```

This tests Ollama, not ollama-intern-mcp. Use it for the "Ollama isn't running" step in [Troubleshooting](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/troubleshooting/).

## Why stdio, not HTTP?

The MCP spec is built for local process trust — the client spawns the server as a child process, stdio is the contract, and nothing binds a port. It keeps the security story small: no network listener, no localhost hijack risk, no auth to botch. The handbook covers the full threat model in [Security](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/security/).
