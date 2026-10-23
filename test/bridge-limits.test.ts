// Local only: how auto-resume reads the limits of this installation's unofficial bridges (Claude, Cursor, Gemini).
// Sources: https://code.claude.com/docs/en/errors, pi-claude-bridge's describeRateLimitFailure,
// https://cursor.com/docs/sdk/typescript, and CLIProxyAPI's issue 5265.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, RESET_GRACE_MS } from "../src/server/extensions/_usage-limits.ts";
import { claudeLimitText, nextClock } from "../src/server/claude-bridge/limits.ts";
import { cursorLimitText } from "../src/server/cursor-bridge-limits.ts";

// 2026-10-22 14:00 in Paris (UTC+2).
const now = Date.parse("2026-10-22T12:00:00Z");
const verdict = (error: string) => classify(error, undefined, now);

test("a clock time in a zone is its next occurrence", () => {
    assert.equal(nextClock(15, 0, now, "Europe/Paris"), Date.parse("2026-10-22T13:00:00Z"));
    assert.equal(nextClock(13, 30, now, "Europe/Paris"), Date.parse("2026-10-23T11:30:00Z"));
    assert.equal(nextClock(9, 0, now, "America/New_York"), Date.parse("2026-10-22T13:00:00Z"));
});

test("Claude Bridge: a five-hour limit resumes at its reset; weekly and spend limits do not", () => {
    // Claude Code's session limit, with its zone.
    assert.deepEqual(
        verdict(claudeLimitText("You've hit your limit · resets 3pm (Europe/Paris)", now)),
        { kind: "reset", at: Date.parse("2026-10-22T13:00:00Z") + RESET_GRACE_MS, from: "message" },
    );
    // pi-claude-bridge names the rejection it saw.
    const named = claudeLimitText(
        "Claude rate limit (five_hour) — resets 4:30:00 PM: You're out of extra usage · resets 4:30pm",
        now,
    );

    assert.equal(verdict(named).kind, "reset");
    // The older form, with Unix seconds.
    assert.deepEqual(
        verdict(claudeLimitText(`Claude AI usage limit reached|${(now + 3_600_000) / 1000}`, now)),
        { kind: "reset", at: now + 3_600_000 + RESET_GRACE_MS, from: "message" },
    );
    assert.equal(
        verdict(claudeLimitText("Claude rate limit (seven_day): You've hit your weekly limit", now))
            .kind,
        "skip",
    );
    assert.equal(
        verdict(claudeLimitText("You've hit your weekly limit · resets Mon 12:00am", now)).kind,
        "skip",
    );
    assert.equal(
        verdict(
            claudeLimitText(
                "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage",
                now,
            ),
        ).kind,
        "skip",
    );
    // Other errors keep their words.
    assert.equal(
        claudeLimitText("Claude Bridge worker exited", now),
        "Claude Bridge worker exited",
    );
});

test("Cursor Bridge: the usage limit waits for a person; a rate limit retries", () => {
    assert.equal(verdict(cursorLimitText("Usage limit exceeded")).kind, "skip");
    assert.equal(
        verdict(
            cursorLimitText(
                '{"error":{"code":"usage_limit_exceeded","message":"On-demand usage is required."}}',
            ),
        ).kind,
        "skip",
    );
    assert.deepEqual(verdict(cursorLimitText("Rate limit exceeded")), {
        kind: "retry",
        limit: true,
    });
});

test("Gemini Bridge: CLIProxyAPI passes Google's reset delay on", () => {
    assert.deepEqual(
        verdict(
            '429 {"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 2h34m12s.","status":"RESOURCE_EXHAUSTED"}}',
        ),
        {
            kind: "reset",
            at: now + (2 * 3600 + 34 * 60 + 12) * 1000 + RESET_GRACE_MS,
            from: "message",
        },
    );
    assert.equal(
        verdict(
            '429 {"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 19h2m.","status":"RESOURCE_EXHAUSTED"}}',
        ).kind,
        "skip",
    );
});
