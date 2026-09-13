import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";
import App from "./App";
import { trackActiveDay } from "@/lib/analytics";
import { onFocusChange } from "@/lib/focus";

// Coming back to check on a session an agent is running sends no prompt and
// starts nothing, so it is the one kind of use the backend's own call sites
// cannot see. Subscribed here rather than from an effect: it lives for the
// process, and StrictMode double-invokes a mount.
onFocusChange((focused) => {
  if (focused) trackActiveDay();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
