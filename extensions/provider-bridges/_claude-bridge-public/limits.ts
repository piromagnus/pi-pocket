/**
 * Claude Code's subscription-limit words, put in a form auto-resume reads (`extensions/_usage-limits.ts`): a five-hour
 * limit with `resets_at`, or a weekly one it leaves alone. Local to this installation: the bridge is not official.
 */

/** The clock time Claude Code gives ("resets 3:45pm", "resets 6:30:00 PM (Europe/Paris)"), and its zone. */
const RESETS =
    /resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(?:([ap])\.?m\.?)?(?:\s*\(([\w/+-]+)\))?/i;
const DAY_MS = 86_400_000;

/** How far a zone's wall clock is ahead of UTC at `at`. */
function offset(zone: string | undefined, at: number): number {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone: zone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        })
            .formatToParts(at)
            .map((part) => [part.type, part.value]),
    );

    return (
        Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute),
            Number(parts.second),
        ) -
        Math.floor(at / 1000) * 1000
    );
}

/** The next time the wall clock in `zone` (the server's when absent) shows `hour:minute`. */
export function nextClock(hour: number, minute: number, now: number, zone?: string): number {
    const ahead = offset(zone, now);
    const wall = new Date(now + ahead);
    const at =
        Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour, minute) -
        ahead;

    return at > now ? at : at + DAY_MS;
}

function resetsAt(message: string, now: number): number | undefined {
    const epoch = /usage limit reached\|(\d{9,13})/i.exec(message)?.[1];

    if (epoch !== undefined) {
        return epoch.length > 10 ? Number(epoch) : Number(epoch) * 1000;
    }

    const clock = RESETS.exec(message);

    if (clock === null) {
        return undefined;
    }

    const half = clock[3]?.toLowerCase();
    const hour = (Number(clock[1]) % (half === undefined ? 24 : 12)) + (half === "p" ? 12 : 0);

    try {
        return nextClock(hour, Number(clock[2] ?? 0), now, clock[4]);
    } catch {
        // An unknown zone: the server's.
        return nextClock(hour, Number(clock[2] ?? 0), now);
    }
}

/** The bridge's error words, with a limit's kind and reset time first; other errors as they are. */
export function claudeLimitText(message: string, now = Date.now()): string {
    const kind = /Claude rate limit \((\w+)\)/i.exec(message)?.[1] ?? "";

    if (
        kind === "" &&
        !/usage limit reached|hit your [\w' ]*limit|limit reached|out of extra usage/i.test(message)
    ) {
        return message;
    }

    // Spend limits and credit stay as they are: auto-resume leaves them to a person.
    if (/spend limit|credit balance|budget/i.test(message)) {
        return message;
    }

    if (
        /seven_day|opus|sonnet/i.test(kind) ||
        /weekly|resets (?:mon|tue|wed|thu|fri|sat|sun)/i.test(message)
    ) {
        return `Claude weekly usage limit reached. ${message}`;
    }

    const at = resetsAt(message, now);

    return `429 Claude 5-hour usage limit reached${at === undefined ? "" : `, resets_at: ${Math.round(at / 1000)}`}. ${message}`;
}
