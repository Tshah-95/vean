// The app shell's loading splash. The Rust `setup` hook spawns the `vean preview`
// sidecar and, once its port is listening, NAVIGATES this window to the viewer it
// serves — so this page is only ever shown briefly at startup (and again during a
// project switch while the new sidecar boots). The splash polls the `preview_port`
// invoke purely to report progress; navigation is Rust-owned (it waits for the
// port to listen first, which JS can't observe cross-origin without CORS).
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";

const status = document.querySelector<HTMLElement>("#status");

function set(message: string): void {
  if (status) status.textContent = message;
}

async function poll(): Promise<void> {
  try {
    const port = await invoke<number | null>("preview_port");
    set(
      port
        ? `Preview engine on 127.0.0.1:${port} — opening editor…`
        : "Starting the preview engine…",
    );
  } catch (error) {
    set(`Waiting for vean… (${String(error)})`);
  }
  window.setTimeout(poll, 500);
}

void poll();
