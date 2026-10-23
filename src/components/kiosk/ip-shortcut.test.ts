import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bindIpShortcut } from "./ip-shortcut";

class TestTarget {
  listeners = new Map<string, Set<(event: object) => void>>();

  addEventListener(type: string, listener: (event: object) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: object) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function element(ignored = false) {
  return {
    closest(selector: string) {
      assert.match(selector, /input/);
      assert.match(selector, /textarea/);
      assert.match(selector, /select/);
      assert.match(selector, /contenteditable/);
      assert.match(selector, /data-ip-shortcut-ignore/);
      return ignored ? this : null;
    },
  };
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const window = new TestTarget();
  const document = Object.assign(new TestTarget(), {
    activeElement: element(),
    visibilityState: "visible",
  });
  const calls: string[] = [];
  const cleanup = bindIpShortcut({
    window: window as unknown as Window,
    document: document as unknown as Document,
    onShow: () => calls.push("show"),
    onHide: () => calls.push("hide"),
  });
  t.after(cleanup);
  function key(type: "keydown" | "keyup", key: string, extra = {}) {
    // Browser-generated events are trusted. A small event source lets these
    // tests model them without weakening the production isTrusted check.
    window.emit(type, {
      key,
      code: `Key${key.toUpperCase()}`,
      target: element(),
      isTrusted: true,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      ...extra,
    });
  }
  function hold() {
    key("keydown", "i");
    key("keydown", "p");
  }
  return { window, document, calls, cleanup, key, hold, tick: t.mock.timers.tick.bind(t.mock.timers) };
}

test("requires both native letter keys for 800 ms in either order", (t) => {
  const { key, tick, calls } = setup(t);
  for (const [first, second] of [["i", "p"], ["P", "I"]]) {
    key("keydown", first);
    tick(1000);
    assert.deepEqual(calls, []);
    key("keydown", second);
    tick(799);
    assert.deepEqual(calls, []);
    tick(1);
    assert.deepEqual(calls, ["show"]);
    key("keyup", first);
    assert.deepEqual(calls, ["show", "hide"]);
    key("keyup", second);
    calls.length = 0;
  }
});

test("repeats neither restart the timer nor reopen a cancelled chord", (t) => {
  const { key, hold, tick, calls, window } = setup(t);
  hold();
  tick(500);
  key("keydown", "i", { repeat: true });
  key("keydown", "p", { repeat: true });
  tick(300);
  assert.deepEqual(calls, ["show"]);
  window.emit("blur");
  key("keydown", "i", { repeat: true });
  key("keydown", "p", { repeat: true });
  tick(1000);
  assert.deepEqual(calls, ["show", "hide"]);
});

test("releasing either key cancels a pending hold and permits another hold", (t) => {
  const { key, hold, tick, calls } = setup(t);
  for (const released of ["i", "p"]) {
    hold();
    tick(500);
    key("keyup", released);
    tick(1000);
    assert.deepEqual(calls, []);
    key("keydown", released);
    tick(800);
    assert.deepEqual(calls, ["show"]);
    key("keyup", "i");
    key("keyup", "p");
    calls.length = 0;
  }
});

test("synthetic events cannot activate or disrupt the hardware shortcut", (t) => {
  const { key, hold, tick, calls } = setup(t);
  key("keydown", "i", { isTrusted: false });
  key("keydown", "p", { isTrusted: false });
  tick(1000);
  assert.deepEqual(calls, []);
  hold();
  key("keyup", "i", { isTrusted: false });
  tick(800);
  assert.deepEqual(calls, ["show"]);
});

test("editable or ignored event targets and focused elements cannot activate", (t) => {
  const { key, tick, document, calls } = setup(t);
  key("keydown", "i", { target: element(true) });
  key("keydown", "p", { target: element(true) });
  tick(1000);
  assert.deepEqual(calls, []);
  document.activeElement = element(true);
  key("keydown", "i");
  key("keydown", "p");
  tick(1000);
  assert.deepEqual(calls, []);
});

test("focus, blur, hidden visibility, and composition cancel pending or shown holds", (t) => {
  const { hold, tick, window, document, calls } = setup(t);
  const cancellations = [
    () => window.emit("blur"),
    () => document.emit("focusin", { target: element(true) }),
    () => {
      document.visibilityState = "hidden";
      document.emit("visibilitychange");
    },
    () => window.emit("compositionstart"),
  ];
  for (const cancel of cancellations) {
    for (const shown of [false, true]) {
      document.visibilityState = "visible";
      hold();
      tick(shown ? 800 : 400);
      cancel();
      tick(1000);
      assert.deepEqual(calls, shown ? ["show", "hide"] : []);
      calls.length = 0;
    }
  }
});

test("modifiers and composing keyboard events cancel instead of activating", (t) => {
  const { key, hold, tick, calls } = setup(t);
  for (const extra of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ]) {
    hold();
    tick(400);
    key("keydown", "i", extra);
    tick(1000);
    assert.deepEqual(calls, []);
    key("keydown", "p", extra);
    tick(1000);
    assert.deepEqual(calls, []);
  }
});

test("keyup physical code clears held keys after the reported letter changes", (t) => {
  const { key, tick, calls } = setup(t);
  key("keydown", "i", { code: "KeyG" });
  key("keydown", "p", { code: "KeyR" });
  tick(800);
  key("keyup", "p", { code: "KeyG" });
  assert.deepEqual(calls, ["show", "hide"]);
  key("keydown", "i", { code: "KeyG" });
  tick(800);
  assert.deepEqual(calls, ["show", "hide", "show"]);
});

test("timer rechecks focus and visibility even if their events were missed", (t) => {
  const { hold, tick, window, document, calls } = setup(t);
  hold();
  document.activeElement = element(true);
  tick(800);
  assert.deepEqual(calls, []);
  document.activeElement = element();
  hold();
  document.visibilityState = "hidden";
  tick(800);
  assert.deepEqual(calls, []);
  document.visibilityState = "visible";
  window.emit("blur");
});

test("cleanup removes every listener and cancels pending or visible output", (t) => {
  const { hold, tick, window, document, calls, cleanup } = setup(t);
  hold();
  tick(800);
  cleanup();
  assert.deepEqual(calls, ["show", "hide"]);
  for (const listeners of [...window.listeners.values(), ...document.listeners.values()]) {
    assert.equal(listeners.size, 0);
  }
  hold();
  tick(1000);
  assert.deepEqual(calls, ["show", "hide"]);
});
