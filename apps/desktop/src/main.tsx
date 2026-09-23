import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";
import App from "./App";
import { trackActiveDay } from "@/lib/analytics";
import { onFocusChange } from "@/lib/focus";
import { startSurveys } from "@/lib/surveys";
import { startAgentUpdateChecks } from "@/hooks/useAgentUpdates";
import { applyZoom } from "@/lib/zoom";

// Coming back to check on a session an agent is running sends no prompt and
// starts nothing, so it is the one kind of use the backend's own call sites
// cannot see. Subscribed here rather than from an effect: it lives for the
// process, and StrictMode double-invokes a mount.
onFocusChange((focused) => {
  if (focused) trackActiveDay();
});

// Here for the same reason, and not in an effect for the same reason: the SDK
// lives for the process, and a mount that runs twice would initialise it twice.
// It refuses itself where the install has opted out, so this is unconditional.
void startSurveys();
startAgentUpdateChecks();
// The webview opens at 100% whatever the reader left it at.
applyZoom();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
