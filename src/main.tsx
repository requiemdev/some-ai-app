import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

document.documentElement.classList.toggle("no-material", !navigator.userAgent.includes("Mac"));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
