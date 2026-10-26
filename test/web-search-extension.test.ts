import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolve } from "node:path";

const extensionDir = fileURLToPath(new URL("../extensions/web-search/", import.meta.url));
const sourceDir = resolve(extensionDir, "../..");
const scripts = [
    "manager.test.ts",
    "module.test.ts",
    "donsetch.test.ts",
    "integration.test.ts",
    "browser.test.ts",
];

test("standalone web-search tests run in the root suite", { timeout: 120_000 }, () => {
    for (const script of scripts) {
        const result = spawnSync(process.execPath, [`test/${script}`], {
            cwd: extensionDir,
            encoding: "utf8",
            env: { ...process.env, PI_POCKET_SOURCE: sourceDir },
            timeout: 60_000,
        });

        assert.equal(result.error, undefined, `${script}: ${result.error?.message ?? ""}`);
        assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
    }
});
