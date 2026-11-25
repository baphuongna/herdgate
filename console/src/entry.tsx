import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConsoleApp } from "./ui.tsx";
import { installConsoleNetworkGuard } from "./ovis/fetch-guard.ts";
import { installConsoleStorageGuard } from "./ovis/storage-guard.ts";
import "../vendor/ovis/src/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./console.css";

installConsoleStorageGuard();
installConsoleNetworkGuard();

const element = document.getElementById("root");
if (!element) throw new Error("Missing Console root element");
createRoot(element).render(<StrictMode><ConsoleApp /></StrictMode>);
