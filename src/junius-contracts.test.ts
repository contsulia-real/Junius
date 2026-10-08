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
  isJuniusDevelopmentInstance,
  loadJuniusContracts,
  resolveJuniusCoreContract,
} from "./junius-contracts.js";
import {
  readJuniusPrompt,
  resetJuniusPrompt,
  resolveJuniusPromptRoot,
  setJuniusPrompt,
} from "./junius-prompt-store.js";

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
  copyFileSync(
    new URL(
      "./junius-prompt-store.ts",
      import.meta.url,
    ),
    join(
      releaseSrc,
      "junius-prompt-store.ts",
    ),
  );
  copyFileSync(
    new URL(
      "../package.json",
      import.meta.url,
    ),
    join(
      releaseSrc,
      "..",
      "package.json",
    ),
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
      new URL("./junius-prompt-store.ts", import.meta.url),
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
      /four-way user choice/u,
    );
    assert.match(
      JUNIUS_DESKTOP_CONTRACT,
      /four user options/u,
    );
    assert.match(
      JUNIUS_CORE_CONTRACT,
      /four-way choice/u,
    );
    assert.match(
      JUNIUS_BROWSER_CONTRACT,
      /junius_computer_permission_request.*four user choices/u,
    );
    assert.match(
      JUNIUS_BROWSER_CONTRACT,
      /JUNIUS_BROWSER_RETAIN_DATA=1/u,
    );
  },
);

test(
  "source-test instructions stay internal while installed Junius uses the normal contract",
  () => {
    const root = mkdtempSync(
      join(
        tmpdir(),
        "junius-contract-source-test-",
      ),
    );

    try {
      const installedEnvironment = {
        LOCALAPPDATA: root,
      };
      const sourceTestEnvironment = {
        LOCALAPPDATA: root,
        JUNIUS_INSTANCE_ROLE:
          "development",
      };

      assert.equal(
        isJuniusDevelopmentInstance(
          installedEnvironment,
        ),
        false,
      );
      assert.equal(
        resolveJuniusCoreContract(
          installedEnvironment,
        ),
        JUNIUS_CORE_CONTRACT,
      );

      assert.equal(
        isJuniusDevelopmentInstance(
          sourceTestEnvironment,
        ),
        true,
      );

      const sourceTestContract =
        resolveJuniusCoreContract(
          sourceTestEnvironment,
        );

      assert.match(
        sourceTestContract,
        /JUNIUS SOURCE TEST INSTANCE/u,
      );
      assert.match(
        sourceTestContract,
        /For ordinary Junius work, use the installed Junius connection/u,
      );
      assert.equal(
        sourceTestContract.endsWith(
          JUNIUS_CORE_CONTRACT,
        ),
        true,
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
  "persistent user prompt overrides take precedence and reset to packaged defaults",
  () => {
    const root = mkdtempSync(
      join(
        tmpdir(),
        "junius-prompt-override-",
      ),
    );
    const environment = {
      LOCALAPPDATA: root,
    };

    try {
      assert.equal(
        resolveJuniusPromptRoot(
          environment,
        ),
        join(
          root,
          "Junius",
          "prompts",
        ),
      );

      const custom =
        "# custom engineering\n";
      const stored =
        setJuniusPrompt(
          "engineering",
          custom,
          environment,
        );
      assert.equal(
        stored.source,
        "custom",
      );
      assert.equal(
        stored.path.includes(
          `${join("Junius", "app")}\${join("", "prompts")}`,
        ),
        false,
      );
      assert.equal(
        readJuniusPrompt(
          "engineering",
          environment,
        ).text,
        custom,
      );
      assert.equal(
        loadJuniusContracts(
          ["engineering"],
          environment,
        )[0]?.text,
        custom,
      );

      const fallback =
        resetJuniusPrompt(
          "engineering",
          environment,
        );
      assert.equal(
        fallback.source,
        "default",
      );
      assert.equal(
        fallback.text,
        JUNIUS_ENGINEERING_CONTRACT,
      );

      const customCore =
        "# custom core\n";
      setJuniusPrompt(
        "core",
        customCore,
        environment,
      );
      assert.equal(
        resolveJuniusCoreContract(
          environment,
        ),
        customCore,
      );
      resetJuniusPrompt(
        "core",
        environment,
      );
      assert.equal(
        resolveJuniusCoreContract(
          environment,
        ),
        JUNIUS_CORE_CONTRACT,
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
