// Import helpers first: app integration stays isolated from the real Pi install and credentials.
import { cleanUp, newSession, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import type { PocketHost, ProviderConfigInput } from "../src/server/host.ts";
import {
    ExtensionLoader,
    prepareDropInFolder,
    type ProviderRegistry,
} from "../src/server/reload.ts";

/** Mimic ModelRuntime's merge semantics, including registrations that throw after changing state. */
class StubProviders implements ProviderRegistry {
    readonly configs = new Map<string, ProviderConfigInput>();
    readonly events: string[] = [];
    fail: string | undefined;

    getProviders() {
        return [{ id: "builtin" }, ...[...this.configs.keys()].map((id) => ({ id }))];
    }

    getRegisteredProviderIds() {
        return [...this.configs.keys()];
    }

    getRegisteredProviderConfig(id: string) {
        return this.configs.get(id);
    }

    registerProvider(id: string, config: ProviderConfigInput) {
        this.events.push(`register:${id}:${config.name}`);
        this.configs.set(id, { ...this.configs.get(id), ...config });

        if (id === this.fail) {
            throw new Error(`cannot register ${id}`);
        }
    }

    unregisterProvider(id: string) {
        this.events.push(`unregister:${id}`);
        this.configs.delete(id);
    }
}

function fixture(t: TestContext, withProviders = true) {
    const directory = mkdtempSync(join(root, "provider-modules-"));
    const builtIn = join(directory, "built-in");
    const dropIn = join(directory, "extensions");
    const notices: string[] = [];
    const choices = new Map<string, boolean>();
    const runtime = new StubProviders();
    const registry = createRegistry();

    let onNotice: (message: string) => void = () => {};

    mkdirSync(builtIn);
    prepareDropInFolder(dropIn, join(import.meta.dirname, "..", "node_modules"));
    const host = {
        notice: (_level: string, message: string) => {
            notices.push(message);
            onNotice(message);
        },
        cwdOf: () => work,
    } as unknown as PocketHost;
    const loader = new ExtensionLoader(
        registry,
        host,
        { builtIn, dropIn },
        (file) => choices.get(file),
        { providers: withProviders ? runtime : undefined },
    );

    t.after(async () => {
        await loader.close();
        rmSync(directory, { recursive: true, force: true });
    });

    return {
        loader,
        runtime,
        registry,
        notices,
        host,
        write: (source: string, file = "module.ts") => writeFileSync(join(dropIn, file), source),
        enable: async (file = "module.ts", enabled = true) => {
            choices.set(file, enabled);
            await loader.apply(file);
        },
        remove: (file = "module.ts") => rmSync(join(dropIn, file)),
        listen: (listener: typeof onNotice) => {
            onNotice = listener;
        },
    };
}

/** Every import owns a distinct captured worker flag; no actual worker or provider request is started. */
function moduleSource(version: string, ids = ["custom"], extra = "") {
    return `
let host;
let disposed = false;
export default async (input) => {
    host = input;
    host.notice("info", "default:${version}");
    return { name: "example-module" };
};
export async function providers() {
    host.notice("info", "providers:${version}");
    return ${JSON.stringify(ids)}.map(id => ({ id, config: {
        name: "${version}",
        ${extra}
        refreshModels: async () => {
            host.notice("info", "state:${version}:" + disposed);
            return [];
        },
    } }));
}
export async function dispose() {
    disposed = true;
    host?.notice("info", "dispose:${version}");
}
`;
}

after(cleanUp);

test("provider modules stay unimported until enabled; async factories work without exposing models", async (t) => {
    const f = fixture(t);

    f.write(moduleSource("v1"));
    await f.loader.loadAll();
    await f.loader.reload("module.ts");
    assert.deepEqual(f.notices, []);
    assert.deepEqual(f.runtime.events, []);
    assert.equal("models" in f.host, false);
    await f.enable();
    assert.deepEqual(f.notices, ["default:v1", "providers:v1"]);
    assert.equal(f.runtime.configs.get("custom")?.name, "v1");
    assert.deepEqual(f.loader.extensionNames(), ["example-module"]);
    await f.enable("module.ts", false);
    assert.equal(f.runtime.configs.size, 0);
    assert.deepEqual(f.loader.extensionNames(), []);
    assert.equal(f.notices.at(-1), "dispose:v1");
    await f.enable();
    assert.equal(f.notices.filter((message) => message === "dispose:v1").length, 1);
    await f.loader.close();
    await f.loader.close();
    assert.equal(f.runtime.configs.size, 0);
    assert.equal(f.notices.filter((message) => message === "dispose:v1").length, 2);
});

test("the last constructor argument is optional: async Durable-only modules still work", async (t) => {
    const f = fixture(t, false);

    f.write("export default async () => [{ name: 'durable-only' }];");
    await f.enable();
    assert.deepEqual(f.loader.extensionNames(), ["durable-only"]);
    f.write(moduleSource("unsupported"));
    await assert.rejects(f.loader.reload("module.ts"), /not supported/);
    assert.deepEqual(f.loader.extensionNames(), ["durable-only"]);
    assert.equal(f.notices.at(-1), "dispose:unsupported");
});

test("reload replaces configs without merging old closures, removes omitted IDs, and disposes only old workers", async (t) => {
    const f = fixture(t);

    f.write(moduleSource("v1", ["custom", "removed"], 'headers: { "old": "old" },'));
    await f.enable();
    const old = f.runtime.configs.get("custom")!;

    f.write(moduleSource("v2"));
    await f.loader.reload("module.ts");
    const current = f.runtime.configs.get("custom")!;

    assert.equal(current.name, "v2");
    assert.equal(current.headers, undefined, "ModelRuntime must not preserve omitted fields");
    assert.equal(f.runtime.configs.has("removed"), false);
    assert.equal(f.notices.at(-1), "dispose:v1");
    await old.refreshModels!({} as never);
    await current.refreshModels!({} as never);
    assert.deepEqual(f.notices.slice(-2), ["state:v1:true", "state:v2:false"]);
    // A same-source reload must still create a fresh module instance, even in the same millisecond.
    await f.loader.reload("module.ts");
    const newest = f.runtime.configs.get("custom")!;

    assert.notEqual(newest.refreshModels, current.refreshModels);
    await newest.refreshModels!({} as never);
    assert.equal(f.notices.at(-1), "state:v2:false");
});

test("built-in, other-module, duplicate, malformed, and externally replaced provider IDs are refused before installation", async (t) => {
    const f = fixture(t);

    f.write(moduleSource("first"));
    await f.enable();
    const first = f.registry.snapshot().extension("example-module");
    const events = [...f.runtime.events];

    for (const [source, why] of [
        [moduleSource("builtin", ["builtin"]), /built-in/],
        [moduleSource("duplicate", ["custom", "custom"]), /more than once/],
        [moduleSource("empty", [""]), /nonempty id/],
        [
            moduleSource("malformed").replace(
                'return ["custom"].map',
                'return undefined; return ["custom"].map',
            ),
            /must return an array/,
        ],
    ] as const) {
        f.write(source);
        await assert.rejects(f.loader.reload("module.ts"), why);
        assert.deepEqual(f.runtime.events, events);
        assert.equal(f.registry.snapshot().extension("example-module"), first);
    }

    f.write(
        moduleSource("second").replace('name: "example-module"', 'name: "another-module"'),
        "other.ts",
    );
    await assert.rejects(f.enable("other.ts"), /module.ts already registers provider custom/);
    assert.deepEqual(f.runtime.events, events);
    f.runtime.registerProvider("external", { name: "outside" });
    f.write(moduleSource("external-conflict", ["external"]));
    await assert.rejects(f.loader.reload("module.ts"), /already registered outside/);
    assert.equal(f.runtime.configs.get("external")?.name, "outside");
    f.write(moduleSource("replacement"));
    f.runtime.registerProvider("custom", { name: "outside" });
    await assert.rejects(f.loader.reload("module.ts"), /no longer owned/);
    await f.enable("module.ts", false);
    assert.equal(
        f.runtime.configs.get("custom")?.name,
        "outside",
        "disable cannot remove another owner's provider",
    );
});

test("providers exported in a previous version are all removed when the new version is Durable-only", async (t) => {
    const f = fixture(t);

    f.write(moduleSource("old", ["custom", "another"]));
    await f.enable();
    f.write('export default async () => ({ name: "example-module" });');
    await f.loader.reload("module.ts");
    assert.equal(f.runtime.configs.size, 0);
    assert.equal(f.notices.at(-1), "dispose:old");
    assert.deepEqual(f.loader.extensionNames(), ["example-module"]);
});

test("startup failures roll back new registrations, report an error, and do not stop other modules", async (t) => {
    const f = fixture(t);

    f.runtime.fail = "broken";
    f.write(moduleSource("failed", ["new", "broken"]));
    f.write('export default async () => ({ name: "working" });', "other.ts");
    // A failed initial apply and a later startup retry must both leave no owned resources.
    await assert.rejects(f.enable(), /cannot register broken/);
    await f.enable("other.ts");
    await f.loader.loadAll();
    assert.equal(f.runtime.configs.size, 0);
    assert.deepEqual(f.loader.extensionNames(), ["working"]);
    assert.match(
        f.loader.list().find((entry) => entry.file === "module.ts")?.error ?? "",
        /cannot register broken/,
    );
    assert.ok(
        f.notices.some((message) =>
            /module.ts failed to load: cannot register broken/.test(message),
        ),
    );
});

test("factory failures and name conflicts dispose staged workers and preserve the old module", async (t) => {
    const f = fixture(t);

    f.write(moduleSource("old"));
    await f.enable();
    const oldExtension = f.registry.snapshot().extension("example-module");
    const oldConfig = f.runtime.configs.get("custom");

    for (const source of [
        moduleSource("default-failure").replace(
            'return { name: "example-module" };',
            'throw new Error("factory failure");',
        ),
        moduleSource("provider-failure").replace(
            'return ["custom"].map',
            'throw new Error("factory failure"); return ["custom"].map',
        ),
        moduleSource("name-failure").replace('name: "example-module"', 'name: "pocket-reserved"'),
    ]) {
        f.write(source);
        await assert.rejects(f.loader.reload("module.ts"));
        assert.equal(f.registry.snapshot().extension("example-module"), oldExtension);
        assert.equal(f.runtime.configs.get("custom"), oldConfig);
        assert.match(f.notices.at(-1)!, /^dispose:/);
    }

    assert.equal(f.notices.includes("dispose:old"), false);
    assert.ok(f.loader.list()[0]?.error);
});

test("partial provider registration and partial extension installation roll back to the old configs and extension", async (t) => {
    const f = fixture(t);

    f.write(moduleSource("old", ["custom"], 'headers: { "old": "old" },'));
    await f.enable();
    const oldExtension = f.registry.snapshot().extension("example-module");
    const oldFunction = f.runtime.configs.get("custom")!.refreshModels;

    f.runtime.fail = "broken";
    f.write(moduleSource("bad-provider", ["custom", "new", "broken"]));
    await assert.rejects(f.loader.reload("module.ts"), /cannot register broken/);
    assert.deepEqual([...f.runtime.configs.keys()], ["custom"]);
    assert.equal(f.runtime.configs.get("custom")!.refreshModels, oldFunction);
    assert.deepEqual(f.runtime.configs.get("custom")!.headers, { old: "old" });
    assert.equal(f.registry.snapshot().extension("example-module"), oldExtension);
    f.runtime.fail = undefined;
    f.write(
        moduleSource("bad-extension").replace(
            'return { name: "example-module" };',
            'return [{ name: "example-module" }, { name: "temporary" }, { name: "invalid", sections: [{ key: "!" }] }];',
        ),
    );
    await assert.rejects(f.loader.reload("module.ts"), /Section key/);
    assert.equal(f.registry.snapshot().extension("example-module"), oldExtension);
    assert.equal(f.registry.snapshot().extension("temporary"), undefined);
    assert.equal(f.runtime.configs.get("custom")!.refreshModels, oldFunction);
    await f.runtime.configs.get("custom")!.refreshModels!({} as never);
    assert.equal(f.notices.at(-1), "state:old:false");
    assert.equal(f.notices.includes("dispose:old"), false);
});

test("cleanup errors are reported without undoing a successful reload or stopping shutdown", async (t) => {
    const f = fixture(t);

    // Make old dispose fail, but keep all worker ownership local to the module.
    f.write(
        moduleSource("old").replace(
            'host?.notice("info", "dispose:old");',
            'throw new Error("cleanup boom");',
        ),
    );
    await f.enable();
    f.write(moduleSource("new"));
    await f.loader.reload("module.ts");
    assert.equal(f.runtime.configs.get("custom")?.name, "new");
    assert.match(f.notices.at(-1)!, /cleanup failed: cleanup boom/);
    assert.equal(f.loader.list()[0]?.error, undefined);
    await f.loader.close();
    assert.equal(f.runtime.configs.size, 0);
    assert.equal(f.notices.at(-1), "dispose:new");
});

test(
    "file removal unregisters providers and awaits module disposal",
    { timeout: 5_000 },
    async (t) => {
        const f = fixture(t);

        f.write(moduleSource("removed"));
        await f.enable();
        f.loader.watch();
        const removed = new Promise<void>((resolve) => {
            f.listen((message) => {
                if (message === "Removed the drop-in extension module.ts.") {
                    resolve();
                }
            });
        });

        f.remove();
        await removed;
        assert.equal(f.runtime.configs.size, 0);
        assert.deepEqual(f.loader.extensionNames(), []);
        assert.deepEqual(f.notices.slice(-2), [
            "dispose:removed",
            "Removed the drop-in extension module.ts.",
        ]);
    },
);

test("disable and close during an async factory cannot install providers or leak staged workers", async (t) => {
    for (const action of ["disable", "close"] as const) {
        const f = fixture(t);
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        f.listen((message) => {
            if (message === "default:waiting") {
                started();
            }
        });
        // A host-owned barrier makes the race deterministic, without timers or live workers.
        Object.assign(f.host, { gate });
        f.write(
            moduleSource("waiting").replace(
                'return { name: "example-module" };',
                'await host.gate; return { name: "example-module" };',
            ),
        );
        const loading = f.enable();

        await entered;
        const stopping = action === "disable" ? f.enable("module.ts", false) : f.loader.close();

        release();
        await Promise.all([loading, stopping]);
        assert.deepEqual(f.runtime.events, []);
        assert.deepEqual(f.loader.extensionNames(), []);
        assert.equal(f.notices.at(-1), "dispose:waiting");
    }
});

test("app shutdown stops the harness before provider disposal and still cleans browsers and lock on errors", async (t) => {
    for (const harnessFails of [false, true]) {
        const dataDir = mkdtempSync(join(root, "provider-shutdown-"));
        const app = await openApp(scriptedModel(), dataDir);
        const events: string[] = [];
        const closeHarness = app.harness.close.bind(app.harness);
        const closeLoader = app.loader.close.bind(app.loader);
        const closeBrowsers = app.browsers.closeAll.bind(app.browsers);

        t.after(() => app.close().catch(() => {}));

        app.harness.close = async (...args) => {
            events.push("harness:start");
            await closeHarness(...args);
            events.push("harness:stopped");

            if (harnessFails) {
                throw new Error("harness cleanup failed");
            }
        };

        app.loader.close = async () => {
            assert.deepEqual(events, ["harness:start", "harness:stopped"]);
            events.push("providers:dispose");
            await closeLoader();

            throw new Error("provider cleanup failed");
        };

        app.browsers.closeAll = async (...args) => {
            events.push("browsers:close");
            await closeBrowsers(...args);
        };

        if (harnessFails) {
            await assert.rejects(app.close(), /harness cleanup failed/);
        } else {
            await app.close();
        }

        assert.deepEqual(events, [
            "harness:start",
            "harness:stopped",
            "providers:dispose",
            "browsers:close",
        ]);
        assert.equal(existsSync(join(dataDir, "harness.lock")), false);
    }
});

test("the app passes its runtime privately and cwdOf resolves a session folder lazily", async (t) => {
    const dataDir = mkdtempSync(join(root, "provider-app-"));
    const dropIn = join(dataDir, "extensions");

    mkdirSync(dropIn);
    writeFileSync(
        join(dropIn, "module.ts"),
        moduleSource("app").replace(
            'name: "app",',
            'name: "app", headers: { cwd: host.cwdOf(1) },',
        ),
    );
    const app = await openApp(scriptedModel(), dataDir);

    t.after(() => app.close());
    assert.equal(app.models.getRegisteredProviderConfig("custom"), undefined);
    const id = await newSession(app);

    writeFileSync(
        join(dropIn, "module.ts"),
        moduleSource("app").replace(
            'name: "app",',
            `name: "app", headers: { cwd: host.cwdOf(${JSON.stringify(id)}) },`,
        ),
    );
    await app.setExtensionEnabled(owner(app), "module.ts", true);
    assert.equal(app.models.getRegisteredProviderConfig("custom")?.headers?.cwd, work);
    const folder = join(root, "changed-folder");

    mkdirSync(folder);
    await app.commands.configure(id, owner(app), { cwd: folder });
    await app.loader.reload("module.ts");
    assert.equal(app.models.getRegisteredProviderConfig("custom")?.headers?.cwd, folder);
    await app.close();
    assert.equal(app.models.getRegisteredProviderConfig("custom"), undefined);
});
