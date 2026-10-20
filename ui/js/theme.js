// Light/dark theme: follows the operating system by default; the toggle (or View › Theme)
// overrides it and the choice is remembered on this computer.

const KEY = "biocraft.theme";
const media = matchMedia("(prefers-color-scheme: dark)");
const SUN = "M12 7a5 5 0 110 10 5 5 0 010-10zm0-5l1 3h-2zm0 20l-1-3h2zM2 12l3-1v2zm20 0l-3 1v-2zM4.9 4.9l2.8 1.4-1.4 1.4zm14.2 14.2l-2.8-1.4 1.4-1.4zM4.9 19.1l1.4-2.8 1.4 1.4zM19.1 4.9l-1.4 2.8-1.4-1.4z";
const MOON = "M20.5 14.6A8.5 8.5 0 019.4 3.5a8.5 8.5 0 1011.1 11.1z";

export function themeChoice() {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export const effectiveTheme = () => {
  const c = themeChoice();
  return c === "system" ? (media.matches ? "dark" : "light") : c;
};

function syncButton() {
  const dark = effectiveTheme() === "dark";
  const icon = document.getElementById("theme-icon");
  if (icon) icon.setAttribute("d", dark ? MOON : SUN);
  const b = document.getElementById("btn-theme");
  if (b) {
    const how = themeChoice() === "system" ? " (following the system)" : "";
    b.title = `${dark ? "Dark" : "Light"} theme${how} — click for ${dark ? "light" : "dark"}. View › Theme to follow the system.`;
  }
}

function syncWindow(choice) {
  // native title bar on desktop (null = follow the system)
  window.__TAURI__?.window?.getCurrentWindow?.().setTheme(choice === "system" ? null : choice).catch(() => {});
}

export function setTheme(choice) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {}
  syncButton();
  syncWindow(choice);
}

export function initTheme() {
  document.getElementById("btn-theme")?.addEventListener("click", () => setTheme(effectiveTheme() === "dark" ? "light" : "dark"));
  media.addEventListener("change", syncButton);
  syncButton();
  syncWindow(themeChoice());
}
