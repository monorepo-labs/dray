import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { Home } from "./pages/Home";
import { Pricing } from "./pages/Pricing";

const routes: Record<string, () => React.ReactNode> = {
  "/": () => <Home />,
  "/pricing": () => <Pricing />,
};

const Page = routes[location.pathname] ?? routes["/"];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
