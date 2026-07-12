import "vitest-browser-react";
import { afterEach, beforeEach } from "vitest";
import { configure } from "vitest-browser-react/pure";

configure({ reactStrictMode: true });

let unexpected: string[] = [];
let originalError: typeof console.error;
let onError: (event: ErrorEvent) => void;
let onRejection: (event: PromiseRejectionEvent) => void;

beforeEach(() => {
  unexpected = [];
  originalError = console.error;
  console.error = (...values: unknown[]) => {
    unexpected.push(values.map(String).join(" "));
    originalError(...values);
  };
  onError = (event) => unexpected.push(`window.error: ${event.message}`);
  onRejection = (event) => unexpected.push(`unhandledrejection: ${String(event.reason)}`);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
});

afterEach(() => {
  console.error = originalError;
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  if (unexpected.length > 0) {
    throw new Error(`Unexpected browser errors:\n${unexpected.join("\n")}`);
  }
});
