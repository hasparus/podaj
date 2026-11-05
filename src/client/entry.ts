import "@fontsource/commit-mono/400.css";
import "@fontsource/commit-mono/500.css";
import { Runtime } from "foldkit";

import { init, ModelSchema, update, view } from "./app.js";
import { writeInstanceToken } from "./instance-token.js";
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
    if (route.page === "compose" && route.instanceToken !== null) {
      writeInstanceToken(route.instanceToken);
      if (route.writeToken !== null) {
        const next = new URL(globalThis.location.href);
        next.hash = route.writeToken;
        globalThis.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`);
      }
    }
    return init(route);
  },
  update,
  view,
});

Runtime.run(application);
