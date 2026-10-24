/** Crée des conversations Pi sur les hôtes de ~/.ssh/config, avec des outils de fichiers et un shell distants. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, wrapSection, hook, ToolTask } from "@earendil-works/pi-durable";
import type { Host, Web } from "./_pocket.d.ts";
import {
    SshWorkspaces,
    parseWorkspace,
    workspaceUri,
    sshAliases,
} from "./_ssh-sessions/runtime.ts";

export const pocketApi = 2;

export default function createSshSessions(host: Host, web: Web) {
    if (typeof host.registerWorkspaceProvider !== "function") {
        throw new Error(
            "SSH Sessions nécessite le raccord des environnements distants. Redémarre Pi Pocket après sa mise à jour.",
        );
    }

    const workspaces = new SshWorkspaces(host.dataDir);
    const isRemote = (cwd: string | undefined) => cwd?.startsWith("ssh://") === true;

    const text = (value: unknown, label: string, max = 4096): string => {
        if (typeof value !== "string" || !value || value.length > max || /[\0\r\n]/.test(value)) {
            throw web.error(400, `${label} invalide.`);
        }

        return value;
    };

    web.client("ssh-sessions", { access: "owner" });
    web.route("GET", "hosts", async () => ({ hosts: await sshAliases() }));
    web.route("POST", "scan", async ({ body }) => workspaces.scan(text(body.host, "Hôte", 128)));
    web.route("POST", "trust", async ({ body }) => {
        if (body.confirmed !== true) {
            throw web.error(400, "Vérifie l’empreinte SSH avant de faire confiance à cet hôte.");
        }

        await workspaces.trust(text(body.host, "Hôte", 128), body.lines);

        return { trusted: true };
    });
    web.route("POST", "sessions", async (request) => {
        if (typeof request.createSession !== "function") {
            throw web.error(503, "Redémarre Pi Pocket pour activer les sessions distantes.");
        }

        const alias = text(request.body.host, "Hôte", 128);
        const path = text(request.body.path ?? "~", "Dossier");

        if (path !== "~" && !path.startsWith("~/") && !path.startsWith("/")) {
            throw web.error(400, "Utilise un chemin absolu, ~ ou ~/dossier.");
        }

        const remotePath = path.startsWith("~") ? `/${path}` : path;

        return request.createSession({
            cwd: workspaceUri(alias, remotePath),
            title: `SSH · ${alias} · ${path}`,
        });
    });

    const wraps = [
        wrapSection("project_context", (original) => ({
            ...original,
            render: async (input, context) => {
                if (!isRemote(input.agent.cwd)) {
                    return original.render(input, context);
                }

                const files = await workspaces.projectContext(input.agent.cwd!, context);

                try {
                    files.unshift({
                        path: join(host.agentDir, "AGENTS.md"),
                        text: await readFile(join(host.agentDir, "AGENTS.md"), "utf8"),
                    });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }
                }

                return (
                    files
                        .map(
                            (file) =>
                                `<file path=${host.text.quoted(file.path)}>\n${host.text.defang(file.text)}\n</file>`,
                        )
                        .join("\n\n") || undefined
                );
            },
        })),
        wrapSection("skills", (original) => ({
            ...original,
            render: (input, context) =>
                isRemote(input.agent.cwd) ? undefined : original.render(input, context),
        })),
        wrapSection("pocket_docs", (original) => ({
            ...original,
            render: (input, context) =>
                isRemote(input.agent.cwd) ? undefined : original.render(input, context),
        })),
        wrapSection("environment", (original) => ({
            ...original,
            render: async (input, context) => {
                if (!isRemote(input.agent.cwd)) {
                    return original.render(input, context);
                }

                const { alias, path } = parseWorkspace(input.agent.cwd!);
                const system = await workspaces.system(input.agent.cwd!, context);

                return `SSH host: ${alias}\nWorking directory: ${path}\nPlatform: ${system.platform}\nToday: ${new Date().toISOString().slice(0, 10)}\nThe read, write, edit and bash tools execute only on this SSH host. Never prefix their paths with ssh://. Subagents inherit this workspace. Browser, MCP integrations, provider credentials and Pocket state remain on the Pocket server, not on the SSH host. Remote skills are not loaded automatically. The local Files/Git panels do not support this workspace; use the remote tools. Publish artifacts with content, not a local file path.`;
            },
        })),
    ];
    const remotePaths = hook(ToolTask, {
        beforeTool: (call, api) => {
            if (!isRemote(host.cwdOf(api.conversationId))) {
                return undefined;
            }

            const args = call.arguments as Record<string, unknown>;

            if (
                (call.name === "artifact" || call.name === "artifact_inline") &&
                args.path !== undefined
            ) {
                return {
                    block: "Dans une session SSH, lis le fichier distant puis publie son contenu avec content, pas path.",
                };
            }

            if (
                call.name === "browser" &&
                args.action === "navigate" &&
                typeof args.url === "string" &&
                /^(file:|\/|~\/|[A-Za-z]:[\\/])/.test(args.url)
            ) {
                return {
                    block: "Le navigateur est sur le serveur Pocket. Il ne peut pas ouvrir un chemin de fichier de l’hôte SSH.",
                };
            }

            return undefined;
        },
    });
    const unregister = host.registerWorkspaceProvider("ssh", {
        env: (cwd) => workspaces.env(cwd),
        resolveCwd: (cwd, signal) => workspaces.resolveCwd(cwd, signal),
    });

    web.onDispose(() => {
        unregister();
        workspaces.close();
    });

    return defineExtension({ name: "ssh-sessions", wraps, hooks: [remotePaths] });
}
