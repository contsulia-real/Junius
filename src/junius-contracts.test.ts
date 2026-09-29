import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  JUNIUS_BROWSER_CONTRACT,
  JUNIUS_CORE_CONTRACT,
  JUNIUS_DESKTOP_CONTRACT,
  JUNIUS_ENGINEERING_CONTRACT,
  loadJuniusContracts,
} from "./junius-contracts.js";

function copyReleaseContractModule(
  releaseSrc: string,
): string {
  mkdirSync(
    releaseSrc,
    { recursive: true },
  );
  const releaseModule = join(
    releaseSrc,
    "junius-contracts.ts",
  );
  copyFileSync(
    new URL(
      "./junius-contracts.ts",
      import.meta.url,
    ),
    releaseModule,
  );
  return releaseModule;
}

function readCoreFromRelease(
  releaseModule: string,
): string {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { JUNIUS_CORE_CONTRACT } from ${JSON.stringify(pathToFileURL(releaseModule).href)}; process.stdout.write(JUNIUS_CORE_CONTRACT);`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        JUNIUS_PROJECT_ROOT:
          process.cwd(),
      },
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    result.stderr,
  );

  return result.stdout;
}

function copyReleasePrompts(
  releasePrompts: string,
): void {
  mkdirSync(
    releasePrompts,
    { recursive: true },
  );

  for (const file of [
    "core.md",
    "engineering.md",
    "desktop.md",
    "browser.md",
  ]) {
    copyFileSync(
      new URL(
        `../prompts/${file}`,
        import.meta.url,
      ),
      join(
        releasePrompts,
        file,
      ),
    );
  }
}

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
    assert.match(
      JUNIUS_CORE_CONTRACT,
      /explicitly requests local computer control/u,
    );
    assert.match(
      JUNIUS_DESKTOP_CONTRACT,
      /Do not call the desktop tool at all/u,
    );
    assert.match(
      JUNIUS_CORE_CONTRACT,
      /Do not call playwright_cli at all/u,
    );
    assert.match(
      JUNIUS_BROWSER_CONTRACT,
      /explicit_user_authorization to true/u,
    );
    assert.match(
      JUNIUS_BROWSER_CONTRACT,
      /JUNIUS_BROWSER_RETAIN_DATA=1/u,
    );
  },
);

test(
  "contract loader falls back to live project prompts for a legacy release snapshot",
  () => {
    const root = mkdtempSync(
      join(
        tmpdir(),
        "junius-contract-fallback-",
      ),
    );
    const releaseSrc = join(
      root,
      "release",
      "src",
    );

    try {
      const releaseModule =
        copyReleaseContractModule(
          releaseSrc,
        );

      assert.equal(
        readCoreFromRelease(
          releaseModule,
        ),
        readFileSync(
          new URL(
            "../prompts/core.md",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    } finally {
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    }
  },
);

test(
  "contract loader prefers release prompts over live project fallback",
  () => {
    const root = mkdtempSync(
      join(
        tmpdir(),
        "junius-contract-release-",
      ),
    );
    const releaseRoot = join(
      root,
      "release",
    );
    const releaseSrc = join(
      releaseRoot,
      "src",
    );
    const releasePrompts = join(
      releaseRoot,
      "prompts",
    );

    try {
      const releaseModule =
        copyReleaseContractModule(
          releaseSrc,
        );
      copyReleasePrompts(
        releasePrompts,
      );
      writeFileSync(
        join(
          releasePrompts,
          "core.md",
        ),
        "# release core\n",
        "utf8",
      );

      assert.equal(
        readCoreFromRelease(
          releaseModule,
        ),
        "# release core\n",
      );
    } finally {
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      );
    }
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
