/**
 * The Cursor SDK's limit words, put in a form auto-resume reads (`extensions/_usage-limits.ts`). Its usage limit is the
 * plan's monthly allowance, or on-demand usage that is off: a person must act, so it reads as monthly. A rate limit
 * stays as it is, and retries after the owner's fixed delay. Local to this installation: the bridge is not official.
 */
import {
    createAssistantMessageEventStream,
    type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

export function cursorLimitText(message: string): string {
    return /usage[_ ]limit[_ ]exceeded|on-demand usage/i.test(message)
        ? `Cursor monthly usage limit: ${message}`
        : message;
}

/** The same events, with an error's words rewritten. */
export function withCursorLimits(events: AssistantMessageEventStream): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    void (async () => {
        try {
            for await (const event of events) {
                if (event.type === "error" && event.reason === "error") {
                    event.error.errorMessage = cursorLimitText(event.error.errorMessage ?? "");
                }

                stream.push(event);
            }
        } finally {
            stream.end();
        }
    })();

    return stream;
}
