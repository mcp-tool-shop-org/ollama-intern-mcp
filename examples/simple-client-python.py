#!/usr/bin/env python3
"""
Minimal MCP client for ollama-intern-mcp — Python / asyncio / stdio.

Spawns the server via `npx -y ollama-intern-mcp`, speaks JSON-RPC 2.0 over
its stdin/stdout, lists the tool surface, then calls `ollama_log_tail`
(deterministic artifact-tier tool — no Ollama round-trip needed).

Run: `python examples/simple-client-python.py`

Teaching example only. Production Python clients should use the official
`mcp` SDK (`pip install mcp`); this hand-rolled harness is the minimum
that demonstrates the stdio wire protocol.
"""

from __future__ import annotations

import asyncio
import json
import sys


async def main() -> None:
    # Spawn the server. npx pulls + runs the latest published build.
    proc = await asyncio.create_subprocess_exec(
        "npx", "-y", "ollama-intern-mcp",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=sys.stderr,  # surface server stderr so install/Ollama errors are visible
    )

    next_id = 1
    pending: dict[int, asyncio.Future] = {}

    async def reader() -> None:
        # JSON-RPC 2.0 framing: one JSON object per newline-delimited line.
        while not proc.stdout.at_eof():
            line = await proc.stdout.readline()
            if not line:
                break
            msg = json.loads(line)
            fut = pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(RuntimeError(msg["error"]))
                else:
                    fut.set_result(msg.get("result"))

    asyncio.create_task(reader())

    async def rpc(method: str, params: dict) -> dict:
        nonlocal next_id
        rid = next_id
        next_id += 1
        fut = asyncio.get_event_loop().create_future()
        pending[rid] = fut
        body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        proc.stdin.write((body + "\n").encode("utf-8"))
        await proc.stdin.drain()
        return await fut

    # 1. Handshake.
    await rpc("initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "simple-client-python", "version": "0.1.0"},
    })

    # 2. List the tool surface.
    listing = await rpc("tools/list", {})
    tools = listing["tools"]
    print(f"Server exposes {len(tools)} tools. First five:")
    for t in tools[:5]:
        print(f"  - {t['name']}")

    # 3. Call a deterministic tool.
    result = await rpc("tools/call", {
        "name": "ollama_log_tail",
        "arguments": {"lines": 5},
    })
    print("\nollama_log_tail →")
    print(json.dumps(result, indent=2))

    proc.terminate()
    await proc.wait()


if __name__ == "__main__":
    asyncio.run(main())
