import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

it("compiles the actual chat JSX when attachment and concurrent-session changes are combined", () => {
  // Store-only tests do not import the page. A malformed Send button once
  // survived those tests while a stale ui/dist masked the Vite build failure.
  const fileName = fileURLToPath(new URL("./Chat.tsx", import.meta.url));
  const result = ts.transpileModule(readFileSync(fileName, "utf8"), {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(errors).toEqual([]);
});
