import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWindowsCommandLine,
  quoteWindowsArgument,
} from "./windows-command-line.js";

test("quoteWindowsArgument leaves simple arguments unchanged", () => {
  assert.equal(quoteWindowsArgument("abc"), "abc");
});

test("quoteWindowsArgument protects spaces and quotes", () => {
  assert.equal(quoteWindowsArgument("a b"), '"a b"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\\"b"');
});

test("buildWindowsCommandLine quotes the executable and each argument", () => {
  assert.equal(
    buildWindowsCommandLine(
      "C:\\Program Files\\node\\node.exe",
      ["-p", "process.platform"],
    ),
    '"C:\\Program Files\\node\\node.exe" -p process.platform',
  );
});
