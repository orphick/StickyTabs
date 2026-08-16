import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

ReactDOM.createRoot(root).render(
  // StrictMode is deliberately not used. It double-invokes effects in development, which
  // would run the workspace load — and therefore the first-run seeding — twice.
  <App />,
);

// The window is frameless with a custom titlebar, so the browser's own context menu and
// text-drag would only ever be in the way.
document.addEventListener("contextmenu", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target?.closest("[data-native-menu]")) event.preventDefault();
});
// Dropping a file onto a webview navigates it, which would replace the whole app. Only
// file drags are blocked — dragging a selection inside the note still works.
function blockFileDrag(event: DragEvent): void {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
}
document.addEventListener("dragover", blockFileDrag);
document.addEventListener("drop", blockFileDrag);
