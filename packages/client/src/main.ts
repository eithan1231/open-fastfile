import { App } from "./app/App.js";

const container = document.getElementById("app");
if (!container) {
  throw new Error("missing #app container in index.html");
}
new App(container).start();
