"use strict";
// Run as an ordinary same-origin script: DevTools evaluate can bypass eval CSP.
window.cspProbeDone = (async () => {
  let evalBlocked = false;
  try { (0, eval)("window.cspEvalRan = true"); } catch { evalBlocked = true; }
  const inline = document.createElement("script");
  inline.textContent = "window.cspInlineRan = true";
  document.head.append(inline);
  const button = document.createElement("button");
  button.setAttribute("onclick", "window.cspHandlerRan = true");
  document.body.append(button);
  button.click();
  const remote = document.createElement("script");
  remote.src = "https://blocked.example.test/script.js";
  document.head.append(remote);
  try { await fetch("https://blocked.example.test/api"); } catch { /* must be denied */ }
  await new Promise(resolve => setTimeout(resolve, 100));
  return {evalBlocked, ran:!!(window.cspEvalRan || window.cspInlineRan || window.cspHandlerRan),
    violations:window.cspViolations};
})();
