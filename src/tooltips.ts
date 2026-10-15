/** Lightweight toolbar hints, shared by mouse hover and keyboard focus. */
export function attachTooltips(container: HTMLElement) {
  const tip = document.createElement("div");
  tip.id = "toolbar-tooltip";
  tip.className = "toolbar-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.append(tip);
  let active: HTMLElement | null = null;
  let timer = 0;

  function hide() {
    window.clearTimeout(timer);
    active?.removeAttribute("aria-describedby");
    active = null;
    tip.hidden = true;
  }

  function show(button: HTMLElement, delay: number) {
    hide();
    active = button;
    timer = window.setTimeout(() => {
      if (button.closest("[inert]") || document.querySelector("dialog[open]")) {
        hide();
        return;
      }
      tip.textContent = button.dataset.tooltip || "";
      if (button.dataset.shortcut) {
        const shortcut = document.createElement("kbd");
        shortcut.textContent = button.dataset.shortcut;
        tip.append(shortcut);
      }
      tip.hidden = false;
      button.setAttribute("aria-describedby", tip.id);
      const rect = button.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - tip.offsetWidth / 2, window.innerWidth - tip.offsetWidth - 8))}px`;
      tip.style.top = `${rect.bottom + 8}px`;
    }, delay);
  }

  function leave() {
    window.clearTimeout(timer);
    timer = window.setTimeout(hide, 100);
  }

  for (const button of container.querySelectorAll<HTMLElement>("[data-tooltip]")) {
    button.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") show(button, 350);
    });
    button.addEventListener("pointerleave", leave);
    button.addEventListener("focus", () => {
      if (button.matches(":focus-visible")) show(button, 0);
    });
    button.addEventListener("blur", hide);
  }
  tip.addEventListener("pointerenter", () => window.clearTimeout(timer));
  tip.addEventListener("pointerleave", leave);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  }, true);
  window.addEventListener("blur", hide);
  window.addEventListener("resize", hide);
  document.addEventListener("scroll", hide, true);
}
