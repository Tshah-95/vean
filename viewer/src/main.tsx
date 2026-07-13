import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
const appRoot = createRoot(root);
appRoot.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// A bounded headless lifecycle seam: removing the actual React product root is the
// only reliable way to exercise every effect cleanup while retaining the page's
// observation bridges. It is absent unless the explicit media-harness query is
// present, so normal app code cannot remotely unmount itself.
if (new URLSearchParams(window.location.search).get("harness") === "media") {
  (window as unknown as { __veanHarnessUnmount?: () => void }).__veanHarnessUnmount = () => {
    appRoot.unmount();
  };
}
