import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "./AppRoot";
import "./main.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
