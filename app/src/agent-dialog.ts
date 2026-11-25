// "Agent" button and dialog: connection status, bridge download for this OS, and setup commands.
import { localAccess, type AgentLink, type Agents } from "./agent";

type Os = "linux" | "darwin" | "windows";
const BINARIES: { os: Os; arch: string; label: string }[] = [
  { os: "darwin", arch: "arm64", label: "macOS (Apple silicon)" },
  { os: "darwin", arch: "amd64", label: "macOS (Intel)" },
  { os: "linux", arch: "amd64", label: "Linux (x86-64)" },
  { os: "linux", arch: "arm64", label: "Linux (ARM64)" },
  { os: "windows", arch: "amd64", label: "Windows (x86-64)" },
  { os: "windows", arch: "arm64", label: "Windows (ARM64)" },
];
const file = (os: Os, arch: string) => `caad-mcp-${os}-${arch}${os === "windows" ? ".exe" : ""}`;

function detectOs(): Os {
  const p = ((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  return p.includes("win") ? "windows" : p.includes("mac") ? "darwin" : "linux";
}

async function detectArch(os: Os): Promise<string> {
  try {
    const v = await (navigator as any).userAgentData?.getHighEntropyValues(["architecture"]);
    if (v?.architecture) return v.architecture === "arm" ? "arm64" : "amd64";
  } catch { /* not available */ }
  return os === "darwin" ? "arm64" : "amd64";
}

const isLocal = () => ["127.0.0.1", "localhost"].includes(location.hostname);

function commands(os: Os, arch: string) {
  const url = `${location.origin}/bridge/${file(os, arch)}`;
  const allow = isLocal() ? "" : ` --allow-origin ${location.origin}`;
  if (os === "windows") {
    const exe = "$env:LOCALAPPDATA\\caad\\caad-mcp.exe";
    return {
      install: `New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\caad" | Out-Null; Invoke-WebRequest ${url} -OutFile "${exe}"`,
      add: `claude mcp add --scope user caad -- "${exe}"${allow}`,
      path: "%LOCALAPPDATA%\\caad\\caad-mcp.exe",
      shell: "PowerShell",
    };
  }
  return {
    install: `mkdir -p ~/.local/bin && curl -fsSL ${url} -o ~/.local/bin/caad-mcp && chmod +x ~/.local/bin/caad-mcp`,
    add: `claude mcp add --scope user caad -- ~/.local/bin/caad-mcp${allow}`,
    path: "~/.local/bin/caad-mcp (use the full path, e.g. /Users/you/.local/bin/caad-mcp)",
    shell: "Terminal",
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const block = (code: string) => `<div class="cmd"><code>${esc(code)}</code><button data-copy="${esc(code)}">Copy</button></div>`;

export function setupAgentDialog(dialog: HTMLDialogElement, button: HTMLButtonElement, agents: Agents) {
  const os = detectOs();
  let arch = os === "darwin" ? "arm64" : "amd64";
  detectArch(os).then((a) => { arch = a; if (dialog.open) render(agents.connected); });

  const render = (links: AgentLink[]) => {
    const c = commands(os, arch);
    const desktop = JSON.stringify({ mcpServers: { caad: { command: c.path.split(" ")[0], args: isLocal() ? [] : ["--allow-origin", location.origin] } } }, null, 2);
    dialog.innerHTML = `
      <form method="dialog"><button class="close" aria-label="Close">×</button></form>
      <h2>Connect an agent</h2>
      <p class="state ${links.length ? "on" : ""}">${links.length
        ? `Connected: ${links.map((l) => esc(l.agent)).join(", ")}`
        : "No agent connected. The page looks for one every few seconds."}</p>
      <p>Your agent (e.g. Claude Code) talks to this page through <b>caad-mcp</b>, a small program that relays messages. Everything else — build123d, the docs, building and checking parts — comes from this page, so the agent needs nothing else installed.</p>
      <h3>1. Install the bridge <span class="muted">(${esc(BINARIES.find((b) => b.os === os && b.arch === arch)?.label ?? os)}, ${c.shell})</span></h3>
      ${block(c.install)}
      <details><summary>Other systems / direct download</summary><ul>${BINARIES.map((b) =>
        `<li><a href="/bridge/${file(b.os, b.arch)}" download>${b.label}</a></li>`).join("")}</ul></details>
      <h3>2. Add it to your agent</h3>
      <p>Claude Code (once, works in every folder):</p>
      ${block(c.add)}
      <details><summary>Claude Desktop and other MCP clients</summary>
        <p>Add this to the client's MCP configuration (for Claude Desktop: Settings → Developer → Edit config):</p>
        <pre>${esc(desktop)}</pre></details>
      <h3>3. Start your agent and ask</h3>
      <p><i>"What have I selected in CAAD?"</i> or <i>"Make a 60 × 40 mm plate with four M4 holes."</i></p>
      <p class="muted" id="local-access" hidden></p>`;
    localAccess().then((a) => {
      const note = dialog.querySelector<HTMLElement>("#local-access");
      if (!note || a === "granted" || a === "none") return;
      note.hidden = false;
      note.textContent = a === "prompt"
        ? "Chrome asks whether this site may access other apps and services on this device: allow it, so the page can reach the bridge on your computer."
        : "Chrome is blocking this site from reaching apps on this device, so the page can't find the bridge. Allow it in the site settings (the icon left of the address bar), then reload the page.";
    });
    dialog.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => {
      b.onclick = () => navigator.clipboard.writeText(b.dataset.copy!).then(() => { b.textContent = "Copied"; });
    });
  };

  const update = (links: AgentLink[]) => {
    button.classList.toggle("connected", links.length > 0);
    button.title = links.length ? `Connected: ${links.map((l) => l.agent).join(", ")}` : "No agent connected — click to set one up";
    if (dialog.open) render(links);
  };
  agents.onChange = update;
  update([]);
  button.onclick = () => { agents.start(); render(agents.connected); dialog.showModal(); }; // may make Chrome ask for local network access
}
