# Using Conduit with Open WebUI

[Open WebUI](https://github.com/open-webui/open-webui) isn't one of Conduit's
one-click clients, because it consumes MCP over HTTP/OpenAPI rather than spawning a
stdio server from a config file. But it works well with **zero gateway changes** by
putting [`mcpo`](https://github.com/open-webui/mcpo) (Open WebUI's own
MCP-to-OpenAPI proxy) in front of the Conduit gateway. Validated end to end: a model
in Open WebUI reaches every server you've connected through Conduit, including
multi-step tool flows.

## The recipe

**1. Run the bridge.** `mcpo` wraps the `conduit-gateway` binary that ships with
Conduit and exposes it as an OpenAPI server.

```bash
# install mcpo once, or run it transiently with uvx
pip install mcpo

# run the bridge (the gateway defaults to your real registry)
CONDUIT_DISCOVERY=lazy mcpo --port 8765 -- /path/to/conduit-gateway
```

mcpo now serves your tools at `http://localhost:8765` (interactive docs at `/docs`).

**2. Add it to Open WebUI.** Settings -> Tools (or Connections) -> add an OpenAPI
tool server pointing at `http://localhost:8765`. The `conduit_*` tools appear.

**3. Set Function Calling to Native (per chat).** This is the setting that silently
breaks things. In the chat's **Controls** panel -> **Advanced Params**, set
**Function Calling** to **Native**, not Default. Default uses prompt-injection and
often never fires (the model just replies "I don't have access to that"); Native
passes the tools through the model's real function-calling API. Note: this can reset
to Default on each new chat, and setting it at the model level
(Workspace -> Models) does not reliably carry over, so set it in the chat itself if
tools stop firing.

**4. Use a capable model.** Lazy discovery (the default) gives the model three
meta-tools and it searches then calls on demand. A capable model (a frontier API
like gpt-4o-mini, or a strong local model in the 14B+ range) handles this well,
including chained multi-step flows. Small local models (a 7B, say) tend to struggle
with the search-then-call chain.

That's it. Ask for something one of your servers does ("list my recent emails",
"show my Vercel projects") and it routes through Conduit.

## Notes

- **Local vs Docker networking.** Run Open WebUI natively (e.g.
  `uvx --python 3.11 open-webui@latest serve`) and it reaches mcpo at
  `http://localhost:8765` directly. If you run Open WebUI in Docker, point the tool
  server at `http://host.docker.internal:8765` instead.
- **Plays well with other tools.** `conduit_search_tools` is written to be the
  model's first stop for any external action, so it competes well against other
  tools you may have installed, no need to disable them.
- **Full discovery.** To expose tools directly (no search step) for a weaker model,
  run `CONDUIT_DISCOVERY=full` scoped to a small profile so the tool count stays
  manageable.

This same bridge works for any HTTP/OpenAPI MCP consumer (n8n, LibreChat, custom
agents), not just Open WebUI.
