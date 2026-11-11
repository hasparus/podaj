import "@fontsource/commit-mono/400.css";
import "./canvas.css";
import type { CanvasScreen } from "./screens.js";
import { SCREENS } from "./screens.js";

type Group = "all" | CanvasScreen["group"];
type View = "desktop" | "mobile" | "both";
interface Artboard {
  label: HTMLElement;
  preview: HTMLIFrameElement;
  width: number;
  x: number;
  y: number;
}
interface GroupLabel {
  element: HTMLElement;
  y: number;
}
interface Camera {
  scale: number;
  x: number;
  y: number;
}

const GROUPS: readonly Group[] = ["all", "start", "verify", "fill", "problems"];
const VIEWS: readonly View[] = ["desktop", "mobile", "both"];
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 2;
const GAP = 80;
const ROW_GAP = 280;
const GROUP_HEAD = 80;
const compactLayout = window.matchMedia("(max-width: 599px)");
const camera: Camera = { scale: 1, x: 0, y: 0 };
let selectedGroup: Group = "all";
let selectedView: View = compactLayout.matches ? "mobile" : "desktop";
let artboards: Artboard[] = [];
let groupLabels: GroupLabel[] = [];
let worldWidth = 0;
let worldHeight = 0;
let spacePressed = false;
let fitted = true;
let drag: { id: number; startX: number; startY: number; x: number; y: number } | undefined;
const touches = new Map<number, { x: number; y: number }>();
let pinch: { distance: number; scale: number; worldX: number; worldY: number } | undefined;

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

const button = (label: string, action: () => void, text = label) => {
  const node = element("button", "canvas-button", text);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.addEventListener("click", action);
  return node;
};

const zoomButton = (direction: "in" | "out", action: () => void) => {
  const control = button(`zoom ${direction}`, action, "");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", direction === "in" ? "M3 8h10M8 3v10" : "M3 8h10");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  icon.appendChild(path);
  control.appendChild(icon);
  return control;
};

const root = document.querySelector<HTMLElement>("#canvas-app");
if (!root) {
  throw new Error("The canvas needs its app mount.");
}

const header = element("header", "canvas-header");
const identity = element("div", "canvas-identity");
identity.replaceChildren(element("h1", "canvas-title", "podaj"), element("span", "canvas-subtitle", "ui canvas"));
const notice = element("p", "canvas-notice", "Local fixtures. Nothing is sent.");
header.replaceChildren(identity, notice);

const toolbar = element("div", "canvas-toolbar");
const navigation = element("nav", "canvas-segment", undefined);
navigation.setAttribute("aria-label", "screen groups");
const viewControls = element("div", "canvas-segment canvas-views");
viewControls.setAttribute("role", "group");
viewControls.setAttribute("aria-label", "preview sizes");
const zoomControls = element("div", "canvas-zoom");
zoomControls.setAttribute("role", "group");
zoomControls.setAttribute("aria-label", "canvas zoom");
const zoomValue = element("output", "canvas-zoom-value", "100%");
zoomValue.setAttribute("aria-label", "zoom percentage");
const zoomAnnouncement = element("span", "visually-hidden");
zoomAnnouncement.setAttribute("role", "status");
const viewport = element("main", "canvas-viewport");
viewport.id = "workspace";
viewport.tabIndex = 0;
viewport.setAttribute("aria-label", "screen review workspace");
viewport.setAttribute("aria-describedby", "canvas-help");
const world = element("div", "canvas-world");
const labels = element("div", "canvas-labels");
const panSurface = element("div", "canvas-pan-surface");
panSurface.setAttribute("aria-hidden", "true");
const empty = element("p", "canvas-empty", "No screens in this group. Choose all to return to the canvas.");
empty.hidden = true;
viewport.replaceChildren(world, labels, panSurface, empty);
const footer = element("footer", "canvas-footer");
const help = element("p", "canvas-help");
help.id = "canvas-help";
const summary = element("p", "canvas-summary");
footer.replaceChildren(help, summary);

const updateCamera = () => {
  const interactive = camera.scale >= 0.5 && !compactLayout.matches;
  help.textContent = compactLayout.matches ? "Drag to pan. Pinch to zoom. Tap a title to open." : "Wheel or pinch to zoom. Drag or Space + drag to pan. Zoom in to edit.";
  world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  zoomValue.textContent = `${Math.round(camera.scale * 100)}%`;
  viewport.style.setProperty("--grid-size", `${Math.max(12, 40 * camera.scale)}px`);
  viewport.style.setProperty("--grid-x", `${camera.x}px`);
  viewport.style.setProperty("--grid-y", `${camera.y}px`);
  for (const board of artboards) {
    board.label.style.left = `${camera.x + board.x * camera.scale}px`;
    board.label.style.top = `${camera.y + board.y * camera.scale - 39}px`;
    board.label.style.width = `${board.width * camera.scale}px`;
    board.preview.inert = !interactive;
    board.preview.tabIndex = interactive ? 0 : -1;
  }
  for (const group of groupLabels) {
    group.element.style.left = `${camera.x - (compactLayout.matches ? 0 : 108)}px`;
    group.element.style.top = `${camera.y + (group.y + (compactLayout.matches ? 0 : GROUP_HEAD)) * camera.scale}px`;
  }
  viewport.classList.toggle("is-overview", camera.scale < 0.24);
  viewport.classList.toggle("is-distant", camera.scale < 0.1);
  viewport.classList.toggle("is-detail", interactive);
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const constrainPan = () => {
  const margin = 96;
  camera.x = clamp(camera.x, -worldWidth * camera.scale + margin, viewport.clientWidth - margin);
  camera.y = clamp(camera.y, -worldHeight * camera.scale + margin, viewport.clientHeight - margin);
};

const fitAll = () => {
  if (!worldWidth || !worldHeight || !viewport.clientWidth || !viewport.clientHeight) {
    return;
  }
  const padding = compactLayout.matches ? 16 : 40;
  const gutter = compactLayout.matches ? 0 : 108;
  const widthScale = (viewport.clientWidth - padding * 2 - gutter) / worldWidth;
  camera.scale = clamp(compactLayout.matches ? widthScale : Math.min(widthScale, (viewport.clientHeight - 100) / worldHeight), MIN_ZOOM, 1);
  camera.x = gutter + (viewport.clientWidth - gutter - worldWidth * camera.scale) / 2;
  camera.y = compactLayout.matches ? 40 : 40 + (viewport.clientHeight - 40 - worldHeight * camera.scale) / 2;
  fitted = true;
  updateCamera();
};

const zoomAt = (scale: number, x: number, y: number) => {
  const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
  const ratio = next / camera.scale;
  camera.x = x - (x - camera.x) * ratio;
  camera.y = y - (y - camera.y) * ratio;
  camera.scale = next;
  fitted = false;
  constrainPan();
  updateCamera();
};

const zoomCentered = (scale: number) => {
  zoomAt(scale, viewport.clientWidth / 2, viewport.clientHeight / 2);
  zoomAnnouncement.textContent = `zoom ${Math.round(camera.scale * 100)} percent`;
};

const zoomByWheel = (event: WheelEvent, x: number, y: number) => {
  event.preventDefault();
  const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
  const delta = clamp(event.deltaY * multiplier, -100, 100);
  zoomAt(camera.scale * Math.exp(-delta * 0.008), x, y);
};

const isEditing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest("input, textarea, select")));
const handleKeyDown = (event: KeyboardEvent) => {
  if (isEditing(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (event.code === "Space" && !(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLAnchorElement)) {
    event.preventDefault();
    spacePressed = true;
    viewport.classList.add("is-space-panning");
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomCentered(camera.scale * 1.25);
  } else if (event.key === "-") {
    event.preventDefault();
    zoomCentered(camera.scale / 1.25);
  } else if (event.key === "0") {
    event.preventDefault();
    fitAll();
  }
};
const releaseSpace = () => {
  spacePressed = false;
  viewport.classList.remove("is-space-panning");
};
const handleKeyUp = (event: KeyboardEvent) => {
  if (event.code === "Space" && spacePressed) {
    releaseSpace();
  }
};

const makeArtboard = (screen: CanvasScreen, device: "desktop" | "mobile", x: number, y: number) => {
  const width = device === "desktop" ? 960 : 390;
  const height = device === "desktop" ? 640 : 844;
  const preview = element("iframe", "canvas-preview");
  const url = `/dev/screen.html?screen=${encodeURIComponent(screen.id)}`;
  preview.src = url;
  preview.title = `${screen.title} · ${screen.state} · ${device} ${width} by ${height}`;
  preview.loading = "lazy";
  preview.width = String(width);
  preview.height = String(height);
  preview.setAttribute("sandbox", "allow-scripts allow-same-origin");
  preview.addEventListener("load", () => {
    const child = preview.contentDocument;
    if (!child) {
      return;
    }
    child.addEventListener("keydown", (event) => {
      if (child.activeElement?.closest("input, textarea, select, button, a, [contenteditable]")) {
        return;
      }
      handleKeyDown(event);
    });
    child.addEventListener("keyup", handleKeyUp);
    child.addEventListener("wheel", (event) => {
      if (child.activeElement?.closest("input, textarea, select, [contenteditable]")) {
        return;
      }
      const frameBounds = preview.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      zoomByWheel(event, frameBounds.left - bounds.left + event.clientX * camera.scale, frameBounds.top - bounds.top + event.clientY * camera.scale);
    }, { passive: false });
  });
  preview.style.left = `${x}px`;
  preview.style.top = `${y}px`;
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  const label = element("div", "canvas-artboard-label");
  const title = element("a", "canvas-artboard-title", screen.title);
  title.href = url;
  title.target = "_blank";
  title.rel = "noopener";
  title.title = `${screen.title} · ${screen.state} · open at real size in a new tab`;
  title.setAttribute("aria-label", `${screen.title}, ${screen.state}, ${device}: open at real size in a new tab`);
  const size = element("span", "canvas-artboard-size", `${width} × ${height}`);
  const top = element("div", "canvas-artboard-heading");
  top.replaceChildren(title, size);
  const meta = element("p", "canvas-artboard-meta", `${screen.state} · ${screen.route}`);
  meta.title = [screen.route, screen.state, screen.note].filter(Boolean).join(" · ");
  label.replaceChildren(top, meta);
  labels.appendChild(label);
  world.appendChild(preview);
  artboards.push({ label, preview, width, x, y });
};

const renderBoards = () => {
  world.replaceChildren();
  labels.replaceChildren();
  artboards = [];
  groupLabels = [];
  const screens = SCREENS.filter((screen) => selectedGroup === "all" || screen.group === selectedGroup);
  empty.hidden = screens.length > 0;
  const wideColumns = selectedGroup === "all" ? 6 : 3;
  const columnCount = compactLayout.matches ? 1 : wideColumns;
  const cellWidth = selectedView === "mobile" ? 390 : 960;
  const cellHeight = selectedView === "desktop" ? 640 : 844;
  const bothWidth = selectedView === "both" ? 390 + GAP : 0;
  const stride = cellWidth + bothWidth + GAP;
  let y = 0;
  let widest = 0;
  for (const group of GROUPS) {
    if (group === "all") {
      continue;
    }
    const members = screens.filter((screen) => screen.group === group);
    if (members.length === 0) {
      continue;
    }
    const heading = element("h2", "canvas-group-title", group);
    const count = element("span", "canvas-group-count", `${members.length} states`);
    heading.appendChild(count);
    labels.appendChild(heading);
    groupLabels.push({ element: heading, y });
    const top = y + (compactLayout.matches ? 240 : GROUP_HEAD);
    for (const [index, screen] of members.entries()) {
      const x = (index % columnCount) * stride;
      const boardY = top + Math.floor(index / columnCount) * (cellHeight + ROW_GAP);
      if (selectedView !== "mobile") {
        makeArtboard(screen, "desktop", x, boardY);
      }
      if (selectedView !== "desktop") {
        makeArtboard(screen, "mobile", x + (selectedView === "both" ? 960 + GAP : 0), boardY);
      }
    }
    widest = Math.max(widest, Math.min(columnCount, members.length) * stride - GAP);
    y = top + Math.ceil(members.length / columnCount) * (cellHeight + ROW_GAP);
  }
  worldWidth = widest;
  worldHeight = Math.max(0, y - ROW_GAP);
  world.style.width = `${worldWidth}px`;
  world.style.height = `${worldHeight}px`;
  summary.textContent = `${screens.length} states · ${artboards.length} previews · ${selectedView}`;
  fitAll();
};

const groupButtons = new Map<Group, HTMLButtonElement>();
const viewButtons = new Map<View, HTMLButtonElement>();
const updateSelection = () => {
  for (const [group, node] of groupButtons) {
    node.setAttribute("aria-pressed", String(group === selectedGroup));
  }
  for (const [view, node] of viewButtons) {
    node.setAttribute("aria-pressed", String(view === selectedView));
  }
  renderBoards();
};

const selectGroup = (group: Group) => {
  selectedGroup = group;
  updateSelection();
};
const selectView = (view: View) => {
  selectedView = view;
  updateSelection();
};
for (const group of GROUPS) {
  const control = button(`show ${group === "all" ? "all screens" : group}`, () => {
    selectGroup(group);
  }, group);
  groupButtons.set(group, control);
  navigation.appendChild(control);
}
for (const view of VIEWS) {
  const control = button(`show ${view} previews`, () => {
    selectView(view);
  }, view);
  viewButtons.set(view, control);
  viewControls.appendChild(control);
}
zoomControls.replaceChildren(
  zoomButton("out", () => { zoomCentered(camera.scale / 1.25); }),
  zoomValue,
  zoomButton("in", () => { zoomCentered(camera.scale * 1.25); }),
  button("fit canvas (0)", fitAll, "fit"),
  button("actual size, 100 percent", () => { zoomCentered(1); }, "1:1"),
  zoomAnnouncement,
);
toolbar.replaceChildren(navigation, viewControls, zoomControls);

const stopDrag = () => {
  const previous = drag;
  drag = undefined;
  if (previous && viewport.hasPointerCapture(previous.id)) {
    viewport.releasePointerCapture(previous.id);
  }
  viewport.classList.remove("is-dragging");
};

viewport.addEventListener("wheel", (event) => {
  if (event.target instanceof Element && event.target.closest("a, button")) {
    return;
  }
  const bounds = viewport.getBoundingClientRect();
  zoomByWheel(event, event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });

const touchGeometry = () => {
  const positions = touches.values();
  const first = positions.next().value;
  const second = positions.next().value;
  if (!first || !second) {
    return null;
  }
  const bounds = viewport.getBoundingClientRect();
  return {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    x: (first.x + second.x) / 2 - bounds.left,
    y: (first.y + second.y) / 2 - bounds.top,
  };
};
viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || (event.target instanceof Element && event.target.closest("a, button, iframe"))) {
    return;
  }
  viewport.focus({ preventScroll: true });
  viewport.setPointerCapture(event.pointerId);
  if (event.pointerType === "touch") {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const geometry = touchGeometry();
    if (geometry) {
      pinch = {
        distance: geometry.distance,
        scale: camera.scale,
        worldX: (geometry.x - camera.x) / camera.scale,
        worldY: (geometry.y - camera.y) / camera.scale,
      };
      drag = undefined;
      event.preventDefault();
      return;
    }
  }
  drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: camera.x, y: camera.y };
  viewport.classList.add("is-dragging");
  event.preventDefault();
});
viewport.addEventListener("pointermove", (event) => {
  if (touches.has(event.pointerId)) {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
  const geometry = touchGeometry();
  if (pinch && geometry) {
    camera.scale = clamp(pinch.scale * geometry.distance / pinch.distance, MIN_ZOOM, MAX_ZOOM);
    camera.x = geometry.x - pinch.worldX * camera.scale;
    camera.y = geometry.y - pinch.worldY * camera.scale;
  } else if (drag && drag.id === event.pointerId) {
    camera.x = drag.x + event.clientX - drag.startX;
    camera.y = drag.y + event.clientY - drag.startY;
  } else {
    return;
  }
  fitted = false;
  constrainPan();
  updateCamera();
});
const releasePointer = (event: PointerEvent) => {
  touches.delete(event.pointerId);
  pinch = undefined;
  stopDrag();
};
viewport.addEventListener("pointerup", releasePointer);
viewport.addEventListener("pointercancel", releasePointer);
viewport.addEventListener("lostpointercapture", releasePointer);

document.addEventListener("keydown", handleKeyDown);
document.addEventListener("keyup", handleKeyUp);
window.addEventListener("blur", () => {
  releaseSpace();
  touches.clear();
  pinch = undefined;
  stopDrag();
});

if (import.meta.env.DEV) {
  root.replaceChildren(header, toolbar, viewport, footer);
  updateSelection();
  compactLayout.addEventListener("change", renderBoards);
  new ResizeObserver(() => {
    if (fitted) {
      fitAll();
    } else {
      constrainPan();
      updateCamera();
    }
  }).observe(viewport);
} else {
  root.replaceChildren(element("p", "canvas-unavailable", "The UI canvas is available in local development only."));
}
