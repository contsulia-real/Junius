import assert from "node:assert/strict";
import test from "node:test";
import {
  supportedPythonVersion,
  windowsInstallPaths,
  windowsRunValue,
  windowsStartupVbs,
} from "./install-core.mjs";

test(
  "installer accepts Python 3.10 or newer",
  () => {
    assert.equal(
      supportedPythonVersion(
        [3, 10, 0],
      ),
      true,
    );
    assert.equal(
      supportedPythonVersion(
        [3, 13, 1],
      ),
      true,
    );
    assert.equal(
      supportedPythonVersion(
        [3, 9, 9],
      ),
      false,
    );
    assert.equal(
      supportedPythonVersion(
        [2, 7, 18],
      ),
      false,
    );
  },
);

test(
  "installer uses LOCALAPPDATA for persistent Windows installation",
  () => {
    const paths =
      windowsInstallPaths({
        LOCALAPPDATA:
          "C:\\Users\\Demo\\AppData\\Local",
      });

    assert.equal(
      paths.root,
      "C:\\Users\\Demo\\AppData\\Local\\Junius",
    );
    assert.equal(
      paths.appRoot,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
    );
    assert.equal(
      paths.venvRoot,
      "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\.venv",
    );
  },
);

test(
  "installer startup reuses the selected Node executable and hides the Host",
  () => {
    const script =
      windowsStartupVbs(
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\app\\scripts\\host-launcher.mjs",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\app",
      );

    assert.match(
      script,
      /node\.exe/u,
    );
    assert.match(
      script,
      /host-launcher\.mjs/u,
    );
    assert.match(
      script,
      /, 0, False/u,
    );

    assert.equal(
      windowsRunValue(
        "C:\\Windows\\System32\\wscript.exe",
        "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.vbs",
      ),
      '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\Users\\Demo\\AppData\\Local\\Junius\\start-junius.vbs"',
    );
  },
);
