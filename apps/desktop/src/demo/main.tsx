import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";

import ComposerDemo from "./ComposerDemo";

// The app's own stylesheet, which `App` imports for itself. Without it every
// token below resolves to nothing and the page draws unstyled.
import "../App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ComposerDemo />
  </React.StrictMode>,
);
