import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";

const SCRIPT_PATH =
  fileURLToPath(
    import.meta.url,
  );
const PROJECT_ROOT =
  resolve(
    dirname(SCRIPT_PATH),
    "..",
  );

export function extractReleaseChangelog(
  markdown,
  version,
) {
  const lines =
    markdown
      .replaceAll("\r\n", "\n")
      .split("\n");
  const heading =
    `## ${version}`;
  const start =
    lines.findIndex(
      (line) =>
        line.trim() ===
        heading,
    );

  if (start < 0) {
    throw new Error(
      `release_changelog_section_missing: ${version}`,
    );
  }

  let end = lines.length;
  for (
    let index = start + 1;
    index < lines.length;
    index += 1
  ) {
    if (
      lines[index]
        .startsWith("## ")
    ) {
      end = index;
      break;
    }
  }

  const body =
    lines
      .slice(
        start + 1,
        end,
      )
      .join("\n")
      .trim();

  if (body.length === 0) {
    throw new Error(
      `release_changelog_section_empty: ${version}`,
    );
  }

  return body;
}

export async function buildReleaseNotes(
  options = {},
) {
  const projectRoot =
    options.projectRoot ??
    PROJECT_ROOT;
  const outputPath =
    options.outputPath ??
    join(
      projectRoot,
      "dist",
      "release-notes.md",
    );
  const packageJson =
    JSON.parse(
      await readFile(
        join(
          projectRoot,
          "package.json",
        ),
        "utf8",
      ),
    );
  const version =
    packageJson.version;

  if (
    typeof version !==
      "string" ||
    version.length === 0
  ) {
    throw new Error(
      "release_package_version_invalid",
    );
  }

  const changelog =
    await readFile(
      join(
        projectRoot,
        "CHANGELOG.md",
      ),
      "utf8",
    );
  const notes =
    extractReleaseChangelog(
      changelog,
      version,
    );

  await mkdir(
    dirname(outputPath),
    { recursive: true },
  );
  await writeFile(
    outputPath,
    notes + "\n",
    "utf8",
  );

  return {
    version,
    outputPath,
    notes,
  };
}

if (
  process.argv[1] !==
    undefined &&
  resolve(process.argv[1]) ===
    SCRIPT_PATH
) {
  const result =
    await buildReleaseNotes();
  console.log(
    JSON.stringify({
      ok: true,
      version:
        result.version,
      output:
        result.outputPath,
    }),
  );
}
