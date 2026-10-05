// Test fixture only (see web-fixture-app.cjs): lets the fixture page report what was really clicked and typed.
"use strict";
const { ipcRenderer } = require("electron");
window.__report = (line) => ipcRenderer.send("fixture-report", String(line));
