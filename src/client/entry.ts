import { Runtime } from "foldkit";

import { init, ModelSchema, update, view } from "./app.js";
import { parseHandoffId } from "./parse-route.js";

const container = document.querySelector("#app");
if (!(container instanceof HTMLElement)) {
  throw new TypeError("#app missing");
}

const application = Runtime.makeApplication({
  Model: ModelSchema,
  container,
  init: () => init(parseHandoffId(globalThis.location.pathname)),
  update,
  view,
});

Runtime.run(application);
