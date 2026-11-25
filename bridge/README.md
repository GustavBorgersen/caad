# caad-mcp — the bridge between your agent and CAAD

A small program (about 6 MB, no runtime needed) that an MCP client such as Claude Code starts. It talks MCP to the agent over stdin/stdout and relays every tool call to the CAAD page over a WebSocket on `127.0.0.1:7337` (or the next free port up to 7346). The page does all the work — it runs build123d — and answers. The bridge reads no files and runs no code.

```
agent ──stdin/stdout (MCP)──► caad-mcp ◄──WebSocket, 127.0.0.1── CAAD page
```

## Install

The CAAD page shows the right commands for your system under **Agent**. For Claude Code on Linux/macOS:

```bash
mkdir -p ~/.local/bin && curl -fsSL https://caad.vercel.app/bridge/caad-mcp-linux-amd64 -o ~/.local/bin/caad-mcp && chmod +x ~/.local/bin/caad-mcp
claude mcp add --scope user caad -- ~/.local/bin/caad-mcp --allow-origin https://caad.vercel.app
```

## Security

- Listens on 127.0.0.1 only.
- Accepts WebSocket connections only from allowed origins: `localhost`/`127.0.0.1` (development) and the sites given with `--allow-origin` (or `CAAD_ALLOW_ORIGIN`). Other web pages can't connect — browsers always send their real origin.
- Relays only; the page decides what each tool does.

## Tools and instructions

`tools.json` (tool names and schemas) and `instructions.md` (sent to the agent on connect) are embedded. The page announces its own tool list when it connects; if it differs, the bridge uses the page's list and notifies the agent (`tools/list_changed`), so a bridge downloaded once keeps working with newer pages.

The agent gets its instructions when it starts, before any page connects, so they can't come from the page: `instructions.md` stays short and stable (what CAAD is; start with `get_status`, read `build123d_guide`). Everything that changes with CAAD — workflow, conventions, projects, sketches — lives in the guide the page serves (`app/public/agent/guide.md`). A bridge only needs updating when the bridge program itself changes.

## Build

```bash
mise install          # Go, see mise.toml
go build -o caad-mcp .
./build.sh            # all systems into dist/, copied to ../app/public/bridge/
```

Tests (from `../app`): `npm run test:bridge` (protocol, origins) and `node tests/agent-e2e.mjs` (real bridge + app in headless Chromium, every tool).
