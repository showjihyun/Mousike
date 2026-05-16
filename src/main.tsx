import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../design-system/colors_and_type.css";
import "../styles.css";
import "./animations.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
