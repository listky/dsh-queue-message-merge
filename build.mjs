import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const source = await readFile(resolve(root, "client.source.mjs"), "utf8");
const exported = [];
const code = source.replace(
  /^export[ \t]+(?:(async)[ \t]+)?(const|let|var|function)[ \t]+([A-Za-z_$][\w$]*)/gm,
  (_match, asyncModifier, declaration, name) => {
    exported.push(name);
    return (asyncModifier ? asyncModifier + " " : "") + declaration + " " + name;
  }
);
const expectedExports = ["inject", "buildMergePlan", "mergeQueuedMessages", "apply"];
if (JSON.stringify(exported) !== JSON.stringify(expectedExports)) {
  throw new Error("Unexpected client exports: " + JSON.stringify(exported));
}
if (/^[ \t]*(?:import|export)\b/m.test(code)) {
  throw new Error("The client contains an import/export form this tiny build step does not support.");
}

const indentedCode = code.split(/\r?\n/).map((line) => line.length === 0 ? "" : "    " + line).join("\n");
const output = [
  "// Generated from client.source.mjs by build.mjs.",
  "window.__ModuleLoader__.load({",
  '  id: "dsh-queue-message-merge",',
  "  factory: (require) => {",
  "    var module = { exports: {} };",
  "    var exports = module.exports;",
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '    Object.defineProperty(exports, "__esModule", { value: true });',
  '    const React = require("react");',
  '    const { defineStore } = require("@deepseek-ai/dsh-client-store");',
  '    const { Toast } = require("@deepseek-ai/dsh-client-ui-primitives");',
  indentedCode,
  "    Object.assign(exports, { " + exported.join(", ") + " });",
  "    return module.exports;",
  "  }",
  "});",
  ""
].join("\n");

await writeFile(resolve(root, "client.js"), output, "utf8");