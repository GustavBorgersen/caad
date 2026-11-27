// Direction A, Studio: building blocks for its mock-up scenes (top bar, timeline rail, code drawer).
/** The rail's switch between the workspace's files and the open part's timeline. */
const rtabs = (on) => `<div class="rtabs"><span class="${on === "Files" ? "on" : ""}" data-icon="folder">Files</span><span class="${on === "Timeline" ? "on" : ""}" data-icon="history">Timeline</span></div>`;
const timeline = ({ hover = -1, active = -1, upto = 8, agent = -1, sketch = false } = {}) => `
  <aside class="rail">
    ${rtabs("Timeline")}
    ${FEATURES.map(([ic, n, label], i) => `${i === upto + 1 ? '<div class="rollback"></div>' : ""}
      <div class="feat ${i === hover ? "hover" : ""} ${i === active ? "active" : ""} ${i > upto ? "off" : ""}">
        <span data-icon="${ic}"></span><span>${n ? `<span class="n">${n}</span>` : ""}${label}</span>${i === agent ? '<i class="tag" title="Changed by the agent"></i>' : "<i></i>"}
      </div>`).join("")}
    ${upto >= 8 && !sketch ? '<div class="rollback"></div>' : ""}
    ${sketch ? '<div class="feat active"><span data-icon="sketch"></span><span><span class="n">sk3</span>Sketch · on the top face</span><i></i></div><div class="rollback"></div>' : ""}
    <div class="params"><h3>Parameters <span data-icon="plus" style="color:var(--faint)"></span></h3>
      <div class="param">radius<input value="22"></div><div class="param">height<input value="14"></div><div class="param">bolt_r<input value="2.5"></div></div>
  </aside>`;
const partTools = (on = "") => [["sketch", "Sketch"], ["extrude", "Extrude"], ["revolve", "Revolve"], ["hole", "Hole"], ["fillet", "Fillet"], ["chamfer", "Chamfer"], ["plane", "Plane"], ["mirror", "Mirror"]]
  .map(([ic, l]) => `<button class="tool ${l === on ? "on" : ""}" data-icon="${ic}">${l}</button>`).join("");
const sketchTools = [["line", "Line"], ["rect", "Rectangle"], ["circle", "Circle"], ["arc", "Arc"], ["point", "Point"], ["dimension", "Dimension"], ["trim", "Trim"], ["construction", "Construct"]]
  .map(([ic, l], i) => `<button class="tool ${i === 5 ? "on" : ""}" data-icon="${ic}">${l}</button>`).join("") + '<button class="tool primary" data-icon="check">Finish</button>';
const topbar = (tools) => `
  <header class="top">
    <span class="logo">CAAD</span>
    <span class="crumb" data-icon="folder"><b>minibrewery</b><span>/</span>hub.py<span data-icon="down"></span></span>
    <nav class="tools">${tools}</nav><span class="spacer"></span>
    <button class="icon-btn" data-icon="undo" title="Undo · Ctrl+Z"></button><button class="icon-btn" data-icon="redo" title="Redo · Ctrl+Y"></button>
    <span class="agent"><i></i>Claude</span>
    <button class="icon-btn" data-icon="code" title="Code · Ctrl+J"></button><button class="icon-btn" data-icon="gear"></button>
  </header>`;
const code = () => { let n = 0; return `<section class="code"><header><span data-icon="code"></span><b>hub.py</b><span>· 31 lines</span></header><pre>${CODE.map(([h, c]) => h === "gap" ? '<div class="gap"></div>' : `<div class="ln ${c ?? ""}" data-n="${++n}">${h || " "}</div>`).join("")}</pre></section>`; };

