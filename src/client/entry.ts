import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import { Runtime } from "foldkit";

import { init, ModelSchema, update, view } from "./app.js";
import { parseAppRoute } from "./parse-route.js";

if (
  navigator.vendor === "Apple Computer, Inc." &&
  /Version\/\S+ Mobile\/\S+ Safari\//u.test(navigator.userAgent)
) {
  document.documentElement.classList.add("mobile-safari");
}

const container = document.querySelector("#app");
if (!(container instanceof HTMLElement)) {
  throw new TypeError("#app missing");
}

const application = Runtime.makeApplication({
  Model: ModelSchema,
  container,
  init: () => {
    const route = parseAppRoute(
      globalThis.location.pathname,
      globalThis.location.hash,
    );
    return init(route, globalThis.location.origin);
  },
  update,
  view,
});

Runtime.run(application);
