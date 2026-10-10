import React from "react";
import { createRoot } from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import App from "./App";
import "./styles.css";

window.MonacoEnvironment = { getWorker: (_workerId, _label) => new EditorWorker() };
loader.config({ monaco });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
