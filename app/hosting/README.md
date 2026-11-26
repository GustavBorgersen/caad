# Hosting CAAD on your own web server

This folder is the whole CAAD site: the app, the CAD kernel (Python, build123d and OpenCascade as
WebAssembly) and the agent bridge downloads. It loads nothing from other sites, so it works on networks
that filter CDNs, PyPI or downloads of archives from the internet.

## Install

Copy the contents of this folder to any folder on a static web server, e.g. `https://intranet.example/caad/`.
No server-side code, database or build step is needed. To update, replace the folder with a newer release.

## Requirements

- **HTTPS.** Browsers only allow *Open folder* (the File System Access API) on `https://` pages or on
  `localhost`. Over plain `http://` the page works, but only with the bundled examples.
- **Chrome or Edge** (for *Open folder*).
- **MIME types.** The server must send JavaScript modules as JavaScript, or the kernel can't start:

  | Extension | Content-Type |
  | :-- | :-- |
  | `.js`, `.mjs` | `text/javascript` (required) |
  | `.wasm` | `application/wasm` |
  | `.whl`, `.zip` | `application/octet-stream` (any binary type works) |
  | `.py`, `.md` | `text/plain` |
  | `.json` | `application/json` |

  Most servers (nginx, Apache, Caddy) know these except sometimes `.mjs` and `.whl`. Some servers refuse
  extensions they don't know (IIS): `web.config` in this folder adds them for IIS; other servers ignore it.
- **Caching (optional).** Everything under `kernel/` and `assets/` has versioned names and can be cached
  for a long time; `index.html` should not be cached, so a new release shows up on reload.

## Agent

The *Agent* dialog downloads the bridge (`caad-mcp`) from this server (`bridge/`) and shows setup commands
with `--allow-origin` set to this server's address, so the bridge accepts this page.

## Check it works

Open the page: after about a minute the bracket example appears. If the kernel fails to start, the message
names the file that couldn't be downloaded (often a MIME type or a filter in front of the server).
