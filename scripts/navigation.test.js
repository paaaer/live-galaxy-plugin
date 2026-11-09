const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(process.env.MAIN_JS || path.join(__dirname, "..", "main.js"), "utf8");
const context = {
  module: { exports: {} },
  require: (name) => {
    if (name !== "obsidian") throw new Error(`Unexpected dependency: ${name}`);
    return { Plugin: class {}, ItemView: class {}, Notice: class {} };
  },
  window: { setTimeout: () => 0 },
  performance,
};
vm.runInNewContext(source + "\nmodule.exports.__test = { GalaxyView, DEFAULT_PRESETS };", context);
const { GalaxyView, DEFAULT_PRESETS } = context.module.exports.__test;

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.text = options.text;
    this.cls = options.cls;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.value = "";
    this.classList = { toggle() {} };
  }
  createEl(tag, options) {
    const child = new Element(tag, options);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  addClass() {}
  appendText() {}
  setAttribute() {}
  setText(text) { this.text = text; }
  empty() { this.children = []; }
  focus() { this.focused = true; }
  closest() { return ["input", "textarea", "select"].includes(this.tag) ? this : null; }
  get firstElementChild() { return this.children[0]; }
}

function fixture(data = {}) {
  let saves = 0;
  const plugin = {
    data: { presets: { Galaxy: DEFAULT_PRESETS.Galaxy }, current: "Galaxy", ...data },
    manifest: { version: "test" },
    saveData() { saves++; },
  };
  const view = new GalaxyView(null, plugin);
  view.canvas = new Element("canvas");
  view.contentEl = new Element();
  view.registerInterval = () => {};
  return { view, saves: () => saves };
}

function workspace(view) {
  const calls = [];
  const rootSplit = {};
  const parent = {};
  const leaf = {
    parent,
    getRoot: () => rootSplit,
    openFile: async (file, options) => calls.push(["open", file, options.active]),
    view: { containerEl: { ownerDocument: { defaultView: { focus: () => calls.push(["window"]) } } } },
  };
  const file = { path: "target.md" };
  const ws = {
    rootSplit,
    getLeavesOfType: () => [leaf],
    getMostRecentLeaf: () => leaf,
    createLeafInParent: (pane) => { calls.push(["create", pane]); return leaf; },
    revealLeaf: async (target) => { assert.equal(target, leaf); calls.push(["reveal"]); },
    setActiveLeaf: (target, options) => { assert.equal(target, leaf); calls.push(["active", options.focus]); },
  };
  view.app = { vault: { getAbstractFileByPath: () => file }, workspace: ws };
  return { ws, leaf, file, calls };
}

test("note opening only focuses the tab/window when enabled", async () => {
  for (const enabled of [undefined, false, true]) {
    const { view } = fixture({ focusOnClick: enabled });
    const { file, calls } = workspace(view);
    await view.openNode(file, false);
    assert.deepEqual(calls, enabled
      ? [["open", file, true], ["reveal"], ["active", true], ["window"]]
      : [["open", file, false]]);
  }
});

test("note opening respects the main pane, avoids popouts, and supports a new tab", async () => {
  const { view } = fixture({ mainGroup: "main" });
  const { ws, leaf, file, calls } = workspace(view);
  view.plugin.findGroup = () => leaf.parent;
  ws.getLeavesOfType = () => [{ getRoot: () => ({}) }];
  await view.openNode(file, false);
  assert.equal(calls[0][0], "create");
  assert.equal(calls[0][1], leaf.parent);
  calls.length = 0;
  ws.getLeavesOfType = () => [leaf];
  await view.openNode(file, true);
  assert.equal(calls[0][0], "create");
  calls.length = 0;
  view.app.vault.getAbstractFileByPath = () => null;
  await view.openNode(file, false);
  assert.deepEqual(calls, []);
});

test("search selects the matching star, opens its note, and persists the focus option", async () => {
  const { view, saves } = fixture();
  const star = { name: "Target", path: "target.md", folder: "", deg: 1, r: 2, sf: 1, p: 1 };
  const neighbour = { name: "Neighbour" };
  view.g.nodes = [star];
  view.g.systems = [{ n: neighbour, planets: [{ nb: star, wr: 3 }] }];
  let opened;
  view.openNode = (node) => { opened = node; };
  const wrap = new Element();
  view.buildPanel(wrap);
  view.searchInput.value = "Target";
  await view.searchInput.listeners.input();
  view.searchList.firstElementChild.listeners.click();
  assert.equal(view.g.follow, star);
  assert.equal(view.g.pulse.n, star);
  assert.equal(opened, star);
  assert.equal(view.canvas.focused, true);
  const flatten = (el) => [el, ...el.children.flatMap(flatten)];
  const label = flatten(wrap).find((el) => el.text === "Focus on click");
  const checkbox = label.parentElement.children.find((el) => el.tag === "input");
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.listeners.change();
  assert.equal(view.plugin.data.focusOnClick, true);
  assert.equal(saves(), 1);
});

test("Escape resets from canvas, panel, and search without hijacking editable controls", () => {
  const { view } = fixture();
  view.buildPanel(new Element());
  view.bindPointer();
  const event = (target) => ({
    key: "Escape", target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  });
  for (const [element, target] of [
    [view.canvas, view.canvas],
    [view.contentEl, new Element("button")],
    [view.searchInput, view.searchInput],
  ]) {
    view.g.cam.zoom = 35;
    view.g.follow = {};
    view.g.target = { x: 10, y: 20, z: 30 };
    element.listeners.keydown(event(target));
    assert.equal(view.g.follow, null);
    assert.equal(view.g.camTween.zoom, DEFAULT_PRESETS.Galaxy.zoom);
    assert.equal(view.g.homing, true);
  }
  view.g.camTween = null;
  for (const tag of ["input", "textarea", "select"]) {
    view.contentEl.listeners.keydown(event(new Element(tag)));
    assert.equal(view.g.camTween, null);
  }
  assert.equal(view.searchInput.value, "");
  assert.equal(view.canvas.focused, true);
});
