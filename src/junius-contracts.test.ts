import assert from "node:assert/strict";
import test from "node:test";
import {
  JUNIUS_BROWSER_CONTRACT,
  JUNIUS_CORE_CONTRACT,
  JUNIUS_DESKTOP_CONTRACT,
  JUNIUS_ENGINEERING_CONTRACT,
  loadJuniusContracts,
} from "./junius-contracts.js";

test(
  "Core contract routes specialized work without embedding capability details",
  () => {
    assert.match(
      JUNIUS_CORE_CONTRACT,
      /load_junius_contracts/u,
    );

    for (
      const mode of [
        "engineering",
        "desktop",
        "browser",
      ]
    ) {
      assert.equal(
        JUNIUS_CORE_CONTRACT.includes(
          mode,
        ),
        true,
      );
    }

    for (
      const detail of [
        "control_begin",
        "key_macro",
        "action_batch",
        "screenshot_after",
        "playwright_cli",
        "localStorage",
        "WebMCP",
      ]
    ) {
      assert.equal(
        JUNIUS_CORE_CONTRACT.includes(
          detail,
        ),
        false,
        "Core unexpectedly embeds specialized detail: " +
          detail,
      );
    }
  },
);

test(
  "specialized contracts contain their required operational behavior",
  () => {
    for (
      const expected of [
        "RED -> GREEN",
        "workspace_apply verification happens AFTER",
        "Do not push unless the user explicitly requested a push",
      ]
    ) {
      assert.equal(
        JUNIUS_ENGINEERING_CONTRACT.includes(
          expected,
        ),
        true,
        "Engineering contract missing: " +
          expected,
      );
    }

    for (
      const expected of [
        "control_begin",
        "control_end",
        "key_macro",
        "action_batch",
        "screenshot_after",
        "screenshot_handle",
        "clipboard_write",
      ]
    ) {
      assert.equal(
        JUNIUS_DESKTOP_CONTRACT.includes(
          expected,
        ),
        true,
        "Desktop contract missing: " +
          expected,
      );
    }

    for (
      const expected of [
        "playwright_cli",
        "-s=<session>",
        "run-code",
        "localStorage",
        "WebMCP",
        "close the same named session",
      ]
    ) {
      assert.equal(
        JUNIUS_BROWSER_CONTRACT.includes(
          expected,
        ),
        true,
        "Browser contract missing: " +
          expected,
      );
    }
  },
);

test(
  "contract loader deduplicates modes while preserving requested order",
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
      assert.match(
        contract.digest,
        /^[a-f0-9]{64}$/u,
      );
      assert.equal(
        contract.text.length >
          500,
        true,
      );
    }
  },
);
