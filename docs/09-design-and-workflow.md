# CAAD — Design goals, layout and workflow

**Date:** 2026-11-27
**Status:** Agreed; built (2026-11-28): 1.5a–1.5g; see the build order
**Part of:** [04 — Roadmap](04-roadmap.md), phase 1.5 ("Layout, visuals and workflow"); replaces the roadmap's "Contrast fixes" item and the "Visual design" brainstorm

## Problem

The UI grew one feature at a time. It works, but it doesn't yet feel like one designed tool:

- **The part gets too little room.** Project browser, timeline and code are three fixed columns that take almost half the width on a laptop; the selection panel and dialogs cover the view.
- **System popups.** New project, new part, deleting a feature and converting a sketch use the browser's `prompt`, `confirm` and `alert`.
- **Few shortcuts.** Only the sketch editor listens to keys (Esc, Delete).
- **Weak states.** The selected and hovered feature are hard to see in the timeline and the code; selection colours differ between the view, the sketch editor and the panels.
- **Code and timeline don't line up at a glance.** The timeline shows `Sketch: Rectangle` while the code says `sk1`; features in the code run together without a break.
- **Technical details in the header** ("Built in 186 ms (Python 0.042 s, mesh 0.008 s)").
- **One theme**, colours hard-coded across `style.css` and the TypeScript.

Onshape and SolidWorks, the tools we know best, show parts beautifully, but their UIs are cluttered: too many options and too many ways to do the same thing. CAAD should be much simpler and more streamlined.

## Design goals

Every UI change is checked against these.

1. **Easy to learn: one clear, coherent workflow.** Ideas and methods carry over from sketches to parts to assemblies and later slicing — it must feel like one tool, not many. The same holds for the agent: it uses the same names and concepts as the person, so working together is always straightforward.
2. **It looks good and is fun.** Beautiful shading and edges, smooth camera moves, satisfying snapping, short and purposeful animations (honouring *reduce motion*). Fast is part of fun: no double builds, no layout jumps.
3. **Themes.** A light and a dark theme to start with, following the system setting by default.
4. **No clutter. The part is the main character.** It always has the space on the screen; menus, panes and panels stay out of its way — they collapse, slide in when needed, and never permanently cover the model.
5. **No system popups.** Every question, message and menu is CAAD's own, styled like the rest. Right-click opens CAAD's context menu.
6. **Shortcuts.** One key for common tools — <kbd>D</kbd> for the dimension tool. Start small; add keys when a need shows up.
7. **One way to do each thing.** Each action has one dialog and one behaviour. The toolbar, the context menu and a shortcut are only different *doors* to the same command — never a second variant of it. When in doubt, leave an option out.
8. **One visual language for states.** Hover, selected, active, preview, error, construction and "the agent did this" look the same in the 3D view, the sketch editor, the timeline and the code.
9. **Code and timeline map one to one.** A timeline row shows the name the code uses (`sk1`, `pl1`); each feature is its own visually separate block of code; hovering one highlights the other.
10. **Never lose work, never block.** Undo and redo for every change — yours in a dialog, the sketch editor or the code, and the agent's. Destructive actions happen at once with an *Undo* in a small message, instead of asking first. Errors show where they happen (at the feature, in the dialog), not in a popup.
11. **Discoverable without manuals.** Tooltips name the command and its shortcut; <kbd>?</kbd> shows all shortcuts; the context menu offers what makes sense for what is under the mouse.
12. **Readable and accessible.** Contrast that passes WCAG AA in both themes, colour never the only cue (shape or line style too), a visible keyboard focus, text that scales.

## Interaction model

### One loop everywhere

Every modelling action follows the same loop, in every mode:

1. **Select** (optional) — faces, edges, sketch entities, features.
2. **Command** — from the toolbar, the context menu or a shortcut.
3. **Dialog or tool** with a **live preview**; it picks up the selection, and clicking in the view adds to it.
4. **Confirm** (<kbd>Enter</kbd>, OK) or **cancel** (<kbd>Esc</kbd>).

Select-first and command-first both work and end in the same dialog: selecting a face and pressing <kbd>E</kbd> equals pressing <kbd>E</kbd> and then picking the face — as the sketch editor's Dimension tool already does with entities. <kbd>Esc</kbd> always backs out one step: cancel the tool, then clear the selection.

### Modes

Part, sketch, and later slicing, are **modes of one layout** (parts and mates need no mode of their own: [08](08-parts-and-mates.md)): the same places for the toolbar, the panels, the selection and the dialogs; only the commands in the toolbar change. Entering a mode never rearranges the screen.

### Commands

All actions are **commands** in one registry: `id`, label, icon, shortcut, when it is available (mode, selection) and what it runs. The toolbar, the context menus, the shortcuts and the tooltips are all built from it, so they cannot drift apart. The agent works with the same concepts: the commands that change the model correspond to the feature types and tools the agent already has (`edit_feature`, `get_selection`, …), named the same way in the agent guide.

### Context menus

Right-click shows the commands available for what is under the mouse, and nothing else:

| Under the mouse | Offers (first ideas) |
| :-- | :-- |
| A face | Sketch on it, Extrude it, Plane from it, View normal to it, Copy selector |
| An edge | Fillet, Chamfer, Copy selector |
| A feature in the timeline | Edit, Rename, Roll back to here, Show code, Delete |
| Sketch entities | The constraints that fit the selection, Construction on/off, Delete |
| Empty view | Standard views, Fit |

### Shortcuts (first set)

Single keys, scoped by mode, following Onshape where it has a well-known key. Nothing is added just to fill the keyboard.

| Where | Keys |
| :-- | :-- |
| Everywhere | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo/redo · <kbd>Esc</kbd> back out · <kbd>Enter</kbd> confirm · <kbd>Delete</kbd> delete the selection · <kbd>F</kbd> fit · <kbd>N</kbd> view normal to the selection or sketch · <kbd>?</kbd> shortcut sheet |
| Part | <kbd>S</kbd> sketch · <kbd>E</kbd> extrude · <kbd>R</kbd> revolve · <kbd>P</kbd> plane · <kbd>H</kbd> hole |
| Sketch | <kbd>L</kbd> line · <kbd>R</kbd> rectangle · <kbd>C</kbd> circle · <kbd>A</kbd> arc · <kbd>P</kbd> point · <kbd>D</kbd> dimension · <kbd>T</kbd> trim · <kbd>Q</kbd> construction on/off |

Keys are ignored while typing in a field or the code editor.

### In-app dialogs and messages

`prompt`, `confirm` and `alert` are replaced by CAAD's own small dialogs (a name for a new project or part) and messages (errors, "Feature deleted · Undo"). Converting a plain sketch, the one real question, is asked in CAAD's own dialog.

### Undo and redo

Code is the source of truth, so undo works on the code: a history of each file's text, one step per change (a dialog's OK, a sketch editor action, an agent edit, a pause in typing). Undo writes the previous text back and rebuilds. Agent edits are labelled in the history and highlighted in the timeline and the view when they arrive.

## Code and timeline

- **Names in the timeline.** A row shows the feature's name when it has one, then what it is: `sk1 · Sketch: Rectangle`, `pl1 · Plane XY + 10`. *Rename* (context menu, <kbd>F2</kbd>) renames the variable and every reference to it — the "Renaming" item left open in [05](05-feature-model.md).
- **A blank line between features.** Inside the part's block, CAAD writes each new feature as its own paragraph, and the examples and the agent guide do the same, so the code reads like the timeline. CAAD never reformats existing code on its own (surgical edits stay surgical, [05](05-feature-model.md)); a blank line doesn't change the timeline.
- **Cross-highlighting.** Hovering a timeline row highlights its lines in the code and its result in the view; putting the cursor in a feature's code highlights its row.
- **The code pane slides in and out** (a toggle and a shortcut), and is closed by default for people who don't need it; it remembers its width.

## Layout

Everything is built around a full-size 3D view. Decided:

- **The view fills the window.** Panels either float over it or slide in from an edge, and can be collapsed; the part re-centres when a panel opens.
- **A slim top bar**: project and part, the mode's commands, Agent, settings (theme). Build times and similar details move to a quiet status line or tooltip.
- **Dialogs dock to one side** of the view, never in front of the part.
- **The selection panel** is compact and appears only while something is selected.

Decided from the mock-ups ([10](10-visual-system.md)): a slim top bar with labelled commands, a **left rail with a Files | Timeline switch** (the workspace's projects and files, or the open part's timeline), dialogs and the code docked on the right.

## Style mock-ups

The style direction is chosen from mock-ups, not in writing:

- **Two or three directions**, each as a static HTML page in `design/mockups/` (no build step; screenshots in this doc), for example a calm *technical* look close to a cleaned-up Onshape, a *floating islands* look with a borderless view and translucent panels, and a warmer, more playful one.
- **Each in both themes**, with the same scenes: a part with its timeline, a feature dialog open, the sketch editor with dimensions, a context menu.
- We pick one (or mix), and write the result down as **10 — Visual system**: colour tokens for both themes, type, icons, spacing, the state colours of goal 8, and the 3D look (shading, edges, background, view cube).

Constraints that hold for every direction: no UI framework (plain TypeScript and CSS, as today); fonts and icons bundled with the site, never from another origin (CLAUDE.md); icons from one open set.

## Build order

| Slice | Contents |
| :-- | :-- |
| **1.5a — Mock-ups** (done) | The style directions above; pick one; write doc 10 |
| **1.5b — Commands and keys** (done) | The command registry; the toolbar, shortcuts, tooltips and <kbd>?</kbd> sheet built from it; the context menus; in-app dialogs and messages instead of `prompt`/`confirm`/`alert` |
| **1.5c — Code ↔ timeline** (done) | Names in the timeline, rename (`rename_feature` in the kernel: the name and its later uses, refused when the name isn't free), a blank line between new features (kernel writer, examples, guide), cross-highlighting (row → code, code → row) |
| **1.5d — Undo** (done) | The per-file history, undo/redo everywhere, agent edits marked |
| **1.5e — Themes and layout** (done) | The tokens of doc 10, light and dark, the new layout |
| **1.5f — The view** (done) | Shading, edges, selection colours, view cube and standard views, smooth camera moves |
| **1.5g — Start-up** (done) | Build once at start-up ([#3](https://github.com/GustavBorgersen/caad/issues/3)) |

1.5b, 1.5c and 1.5d don't depend on the style and can start while the mock-ups are discussed. Each slice comes with tests, like every feature (headless UI suites check keys, menus and that no native popup opens).

## Decided for now

| Question | Decision |
| :-- | :-- |
| **Command palette** (<kbd>Ctrl</kbd>+<kbd>K</kbd>) | Not now: it would be one more way to do things (goal 7). The <kbd>?</kbd> sheet and tooltips cover discovery; reconsider when the command list grows |
| **Customisable shortcuts** | Not now |
| **Touch and small screens** | Out of scope; desktop Chrome and Edge, as today |
| **Reformatting existing code** | Never automatic; new code gets the blank lines |
| **Theme default** | Follow the system; a toggle in settings overrides it |
