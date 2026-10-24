/** Check login metadata without reading or logging Claude credentials. This makes no model request. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertSubscriptionEnvironment } from "./protocol.ts";

const execute = promisify(execFile);

export async function assertClaudeLogin(executable = "claude"): Promise<void> {
    assertSubscriptionEnvironment(process.env);
    let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string };

    try {
        const { stdout } = await execute(executable, ["auth", "status"], {
            timeout: 15_000,
            maxBuffer: 64 * 1024,
        });

        status = JSON.parse(stdout) as typeof status;
    } catch {
        throw new Error(
            "Claude Bridge needs Claude Code on PATH (or PI_POCKET_CLAUDE_EXECUTABLE) and a Claude subscription login. Run `claude auth login` yourself.",
        );
    }

    if (
        !status ||
        !status.loggedIn ||
        status.authMethod !== "claude.ai" ||
        status.apiProvider !== "firstParty"
    ) {
        throw new Error(
            "Claude Bridge requires a first-party Claude subscription login, not an API key or gateway.",
        );
    }
}
