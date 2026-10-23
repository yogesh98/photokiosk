const HOLD_DELAY_MS = 800;
const IGNORE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-ip-shortcut-ignore]';

type ShortcutKey = "i" | "p";

type IpShortcutOptions = {
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "activeElement" | "visibilityState"
  >;
  onShow: () => void;
  onHide: () => void;
};

function ignoresShortcut(target: EventTarget | null) {
  // Checking the method also works for elements from another browser realm.
  const element = target as Element | null;
  return typeof element?.closest === "function" && Boolean(element.closest(IGNORE_SELECTOR));
}

function shortcutKey(event: KeyboardEvent): ShortcutKey | null {
  const key = event.key.toLowerCase();
  if (key === "i" || key === "p") return key;
  return null;
}

/** Bind the hardware-only I + P hold shortcut; call the result when unmounting. */
export function bindIpShortcut({ window, document, onShow, onHide }: IpShortcutOptions) {
  const pressed = new Set<ShortcutKey>();
  const physicalKeys = new Map<string, ShortcutKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let showing = false;

  function hide() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (showing) {
      showing = false;
      onHide();
    }
  }

  function cancel() {
    pressed.clear();
    physicalKeys.clear();
    hide();
  }

  function shouldIgnore(event: KeyboardEvent) {
    return (
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      document.visibilityState !== "visible" ||
      ignoresShortcut(event.target) ||
      ignoresShortcut(document.activeElement)
    );
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!event.isTrusted) return;
    if (shouldIgnore(event)) {
      cancel();
      return;
    }
    const key = shortcutKey(event);
    if (!key || event.repeat || pressed.has(key)) return;
    pressed.add(key);
    if (event.code) physicalKeys.set(event.code, key);
    if (pressed.size !== 2 || timer !== undefined || showing) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (document.visibilityState !== "visible" || ignoresShortcut(document.activeElement)) {
        cancel();
        return;
      }
      showing = true;
      onShow();
    }, HOLD_DELAY_MS);
  }

  function onKeyUp(event: KeyboardEvent) {
    if (!event.isTrusted) return;
    if (shouldIgnore(event)) {
      cancel();
      return;
    }
    // Follow the original physical key if its reported letter changed while
    // held (including when I or P lives elsewhere on the keyboard layout).
    const key = physicalKeys.get(event.code) ?? shortcutKey(event);
    if (!key) return;
    pressed.delete(key);
    for (const [code, letter] of physicalKeys) {
      if (letter === key) physicalKeys.delete(code);
    }
    hide();
  }

  function onFocusIn(event: FocusEvent) {
    if (ignoresShortcut(event.target) || ignoresShortcut(document.activeElement)) cancel();
  }

  function onVisibilityChange() {
    if (document.visibilityState !== "visible") cancel();
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("compositionstart", cancel, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("compositionstart", cancel, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    cancel();
  };
}
