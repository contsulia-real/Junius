import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  JUNIUS_BROWSER_CONTRACT,
  JUNIUS_CORE_CONTRACT,
  JUNIUS_DESKTOP_CONTRACT,
  JUNIUS_ENGINEERING_CONTRACT,
  loadJuniusContracts,
} from "./junius-contracts.js";

test(
  "operating contracts are sourced from editable Markdown files",
  () => {
    const expected = [
      ["core.md", JUNIUS_CORE_CONTRACT],
      ["engineering.md", JUNIUS_ENGINEERING_CONTRACT],
      ["desktop.md", JUNIUS_DESKTOP_CONTRACT],
      ["browser.md", JUNIUS_BROWSER_CONTRACT],
    ] as const;

    for (const [file, contract] of expected) {
      const markdown = readFileSync(
        new URL(`../prompts/${file}`, import.meta.url),
        "utf8",
      );
      assert.equal(contract, markdown);
    }

    const source = readFileSync(
      new URL("./junius-contracts.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /readFileSync/u);
    assert.match(source, /\.\.\/prompts\//u);
    assert.doesNotMatch(
      source,
      /export const JUNIUS_CORE_CONTRACT = `/u,
    );
  },
);

test(
  "contract loader deduplicates modes while preserving requested order and content digests",
  () => {
    const loaded =
      loadJuniusContracts([
        "desktop",
        "engineering",
        "desktop",
        "browser",
      ]);

    assert.deepEqual(
      loaded.map(
        (contract) =>
          contract.mode,
      ),
      [
        "desktop",
        "engineering",
        "browser",
      ],
    );

    for (
      const contract of
      loaded
    ) {
      assert.equal(
        contract.digest,
        createHash("sha256")
          .update(
            contract.text,
            "utf8",
          )
          .digest("hex"),
      );
    }
  },
);
