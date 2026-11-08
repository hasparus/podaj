import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import { Runtime } from "foldkit";

import { init, ModelSchema, update, view } from "./app.js";
import { parseAppRoute } from "./parse-route.js";

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
    return init(route);
  },
  update,
  view,
});

Runtime.run(application);
