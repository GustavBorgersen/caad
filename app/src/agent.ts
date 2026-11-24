// Connection to local caad-mcp bridges (one per agent session) on 127.0.0.1:7337-7346.
// The page announces its tool list and answers tool calls; the bridge only relays.
import tools from "../../bridge/tools.json";

export type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
export type ToolHandler = (args: any) => Promise<ToolResult>;

const FIRST_PORT = 7337;
const PORTS = 10;
const SCAN_MS = 4000;

export type AgentLink = { port: number; agent: string; bridge: string };

export class Agents {
  private sockets = new Map<number, WebSocket>();
  private links = new Map<number, AgentLink>();
  onChange: (links: AgentLink[]) => void = () => {};
  onCall: (name: string) => void = () => {};

  constructor(private handlers: Record<string, ToolHandler>) {
    this.scan();
    setInterval(() => this.scan(), SCAN_MS);
  }

  get connected(): AgentLink[] { return [...this.links.values()]; }

  private scans = 0;

  /**
   * Bridges take the lowest free port, so look at ports in order and stop at the first one with nothing
   * listening; every few scans, try them all (a bridge may remain on a higher port after another quit).
   */
  private async scan() {
    if (document.hidden) return; // no need to look while the tab is in the background
    const full = this.scans++ % 8 === 0;
    for (let port = FIRST_PORT; port < FIRST_PORT + PORTS; port++) {
      if (this.sockets.has(port)) continue;
      const open = await this.connect(port);
      if (!open && !full) break;
    }
  }

  /** Resolves true when a bridge answered on this port. */
  private connect(port: number): Promise<boolean> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.sockets.set(port, ws);
    let settle: (open: boolean) => void = () => {};
    const result = new Promise<boolean>((resolve) => { settle = resolve; });
    ws.onopen = () => { settle(true); ws.send(JSON.stringify({ type: "hello", client: "caad", tools })); };
    ws.onclose = () => {
      settle(false);
      this.sockets.delete(port);
      if (this.links.delete(port)) this.onChange(this.connected);
    };
    ws.onerror = () => {}; // nothing listening on this port: normal while scanning
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "hello") {
        this.links.set(port, { port, agent: m.agent || "an agent", bridge: m.bridge });
        this.onChange(this.connected);
      } else if (m.type === "call") {
        this.onCall(m.name);
        const handler = this.handlers[m.name];
        try {
          if (!handler) throw new Error(`This CAAD page has no tool "${m.name}". Reload the page or update the bridge.`);
          ws.send(JSON.stringify({ type: "result", id: m.id, result: await handler(m.arguments ?? {}) }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: m.id, error: String((err as Error).message ?? err) }));
        }
      }
    };
    return result;
  }
}

export const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });
