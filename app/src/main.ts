import "./styles.css";

const status = document.querySelector<HTMLPreElement>("#status");

if (status) {
  status.textContent = JSON.stringify(
    {
      surface: "tauri",
      ready: true,
    },
    null,
    2,
  );
}
