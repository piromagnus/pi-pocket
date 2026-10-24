// Integration against a Pi Pocket source checkout, with isolated data and scripted models.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, mkdirSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = process.env.PI_POCKET_SOURCE;

if (!source) {
    test(
        "Pi Pocket source integration",
        { skip: "Set PI_POCKET_SOURCE to a Pi Pocket source checkout" },
        () => {},
    );
} else {
    const helpers = await import(pathToFileURL(join(source, "test/helpers.ts")).href);
    const { createHandler } = await import(pathToFileURL(join(source, "src/server/http.ts")).href);
    const { createPublicFetch } = await import(
        pathToFileURL(join(source, "src/server/public-fetch.ts")).href
    );

    after(helpers.cleanUp);

    test("web-access.ts keeps its enabled identity after restart and serves owner routes and tools", async () => {
        const dataDir = join(helpers.root, "web-search-integration");
        const dropIn = join(dataDir, "extensions");
        const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

        mkdirSync(dropIn, { recursive: true });
        cpSync(join(packageDir, "web-search.ts"), join(dropIn, "web-access.ts"));
        cpSync(join(packageDir, "web-search"), join(dropIn, "web-search"), { recursive: true });

        const makeCall = (app: any) => {
            const handler = createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            });

            // Native HTTP objects over an in-memory socket: no TCP listener or external requests.
            return async (token: string, path = "state", body?: unknown) => {
                const socket = new Duplex({
                    read() {},
                    write(_chunk, _encoding, done) {
                        done();
                    },
                });
                const request = new IncomingMessage(socket as never);

                request.url = path.startsWith("/api/") ? path : `/api/x/web-access/${path}`;
                request.method = body === undefined ? "GET" : "POST";
                request.headers = {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                };

                if (body !== undefined) {
                    request.push(Buffer.from(JSON.stringify(body)));
                }

                request.push(null);
                request.complete = true;
                const response = new ServerResponse(request);

                response.assignSocket(socket as never);
                const finished = once(response, "finish");

                await handler(request, response);
                await finished;

                return { status: response.statusCode };
            };
        };

        let app = await helpers.openApp(helpers.scriptedModel(), dataDir);

        try {
            let call = makeCall(app);
            const initial = app.loader.list().find((m: any) => m.file === "web-access.ts");

            assert.equal(initial?.enabled, false);
            assert.equal(
                (
                    await call(app.config.ownerToken, "/api/extensions/web-access.ts", {
                        enabled: true,
                    })
                ).status,
                200,
            );
            let module = app.loader.list().find((m: any) => m.file === "web-access.ts");

            assert.equal(module.error, undefined);
            assert.equal(module.web.access, "owner");
            assert.equal((await call(app.config.ownerToken)).status, 200);

            for (const tool of [
                "web_search",
                "fetch_content",
                "web_crawl",
                "web_research",
                "web_research_status",
            ]) {
                assert.ok(
                    module.extensions.flatMap((extension: any) => extension.tools).includes(tool),
                );
            }

            for (const role of ["guest", "viewer"]) {
                const user = app.config.addUser(role, role);

                assert.equal((await call(user.token)).status, 404);
                assert.equal(
                    (await call(user.token, "/api/extensions/web-access.ts", { enabled: false }))
                        .status,
                    403,
                );
                assert.equal((await call(user.token, "state", { enabled: false })).status, 404);
            }

            assert.equal(
                (
                    await call(app.config.ownerToken, "state", {
                        providerSettings: { exa: { mode: "invalid" } },
                    })
                ).status,
                400,
            );

            await app.close();
            app = await helpers.openApp(helpers.scriptedModel(), dataDir);
            call = makeCall(app);
            module = app.loader.list().find((m: any) => m.file === "web-access.ts");

            assert.equal(module?.enabled, true);
            assert.equal(module?.error, undefined);
            assert.equal((await call(app.config.ownerToken)).status, 200);

            for (const tool of [
                "web_search",
                "fetch_content",
                "web_crawl",
                "web_research",
                "web_research_status",
            ]) {
                assert.ok(
                    module.extensions.flatMap((extension: any) => extension.tools).includes(tool),
                );
            }

            assert.equal(
                (
                    await call(app.config.ownerToken, "/api/extensions/web-access.ts", {
                        enabled: false,
                    })
                ).status,
                200,
            );
            assert.equal((await call(app.config.ownerToken)).status, 404);
        } finally {
            await app.close();
        }
    });

    test("the real host network guard rejects non-public destinations before connecting", async () => {
        const fetchPublic = createPublicFetch();

        for (const url of [
            "http://127.0.0.1",
            "http://169.254.169.254",
            "http://100.64.0.1",
            "http://[::ffff:127.0.0.1]",
        ]) {
            await assert.rejects(
                () => fetchPublic(url),
                (error: any) => error.code === "POCKET_NOT_PUBLIC",
            );
        }
    });
}
