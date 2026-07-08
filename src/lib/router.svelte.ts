/** Minimal history-API router: `route.path` is reactive; navigate() pushes/replaces. */

export const route = $state({ path: location.pathname });

window.addEventListener("popstate", () => {
  route.path = location.pathname;
});

export function navigate(to: string, replace = false): void {
  if (to === route.path) return;
  if (replace) history.replaceState({}, "", to);
  else history.pushState({}, "", to);
  route.path = to;
}
