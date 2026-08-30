import React from "react";
import ReactDOM from "react-dom/client";
import "streamdown/styles.css";
import "../App.css";

import AuthNoticeDemo from "./AuthNoticeDemo";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthNoticeDemo />
  </React.StrictMode>,
);
