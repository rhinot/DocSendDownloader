globalThis.DocSendDiagnostics = (() => {
    const loggedErrors = new WeakSet();
    class DownloadError extends Error {
        constructor(code, message, details = {}) {
            super(message);
            this.name = "DownloadError";
            this.code = code;
            this.details = details;
        }
    }

    const createError = (code, message, details) => new DownloadError(code, message, details);

    const describeNativeFailure = (error) => {
        const message = typeof error?.message === "string" ? error.message : "";
        const causes = [
            [/cannot access|missing host permission|cannot be scripted/i, "Chrome denied access to the page. Check the extension's site permissions."],
            [/extension context invalidated/i, "The extension was reloaded. Reload the DocSend page."],
            [/already been declared/i, "The page already contains conflicting extension scripts. Reload the page."],
            [/receiving end does not exist|could not establish connection/i, "The page has no available extension listener."],
            [/disconnected port|message port closed/i, "The page connection closed, possibly after navigation or a reload."],
            [/content security policy|unsafe-eval/i, "A browser content security policy blocked script execution."],
            [/unknown image format|invalid (?:png|jpeg)|unsupported image/i, "The slide data is not a supported image."],
            [/out of memory|allocation failed|array buffer allocation/i, "The browser could not allocate enough memory."]
        ];
        return causes.find(([pattern]) => pattern.test(message))?.[1];
    };

    const logFailure = (error, context = {}) => {
        if (error && typeof error === "object") {
            if (loggedErrors.has(error)) return;
            loggedErrors.add(error);
        }
        const knownError = error instanceof DownloadError;
        const entry = {
            code: knownError ? error.code : context.code || "UNEXPECTED_ERROR",
            operation: context.operation || "download",
            reason: knownError ? error.message : context.reason || "An unexpected download error occurred.",
            errorType: ["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError",
                "SecurityError", "NotAllowedError", "DownloadError", "AbortError"]
                .includes(error?.name) ? error.name : "Error"
        };
        const cause = knownError ? undefined : describeNativeFailure(error);
        if (cause) entry.cause = cause;
        if (Number.isSafeInteger(context.slideNumber)) {
            entry.slideNumber = context.slideNumber;
        }
        if (knownError && Number.isInteger(error.details.httpStatus)) {
            entry.httpStatus = error.details.httpStatus;
        }
        // Only controlled messages and numeric context are logged; raw exceptions can contain private URLs.
        console.error("[DocSend Downloader]", entry);
    };

    return Object.freeze({createError, logFailure});
})();
