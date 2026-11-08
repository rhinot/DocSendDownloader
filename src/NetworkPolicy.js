globalThis.DocSendNetworkPolicy = (() => {
    const docSendDomains = ["docsend.com", "docsend.dropbox.com"];
    const matchesDomain = (hostname, domain) =>
        hostname === domain || hostname.endsWith(`.${domain}`);

    const parseHttpsUrl = (value) => {
        if (typeof value !== "string") {
            throw DocSendDiagnostics.createError("INVALID_URL", "A valid download URL is required.");
        }

        let url;
        try {
            url = new URL(value);
        } catch {
            throw DocSendDiagnostics.createError("INVALID_URL", "The download URL is invalid.");
        }
        if (url.protocol !== "https:") {
            throw DocSendDiagnostics.createError("HTTPS_REQUIRED", "Downloads require HTTPS.");
        }
        if (url.username || url.password) {
            throw DocSendDiagnostics.createError("URL_CREDENTIALS_BLOCKED", "Embedded URL credentials are blocked.");
        }
        if (url.port) {
            throw DocSendDiagnostics.createError("CUSTOM_PORT_BLOCKED", "Custom download ports are blocked.");
        }
        return url;
    };

    const isDocSendPage = (value) => {
        try {
            const url = parseHttpsUrl(value);
            return docSendDomains.some((domain) => matchesDomain(url.hostname, domain));
        } catch {
            return false;
        }
    };

    const validateImageUrl = (value) => {
        const url = parseHttpsUrl(value);
        if (!isDocSendPage(url.href) && !url.hostname.endsWith(".cloudfront.net")) {
            throw DocSendDiagnostics.createError("HOST_BLOCKED", "The slide image host is not approved.");
        }
        return url.href;
    };

    const fetchReadOnly = async (url, credentials) => {
        let response;
        try {
            response = await fetch(url, {
                method: "GET",
                credentials,
                referrerPolicy: "no-referrer",
                redirect: "error"
            });
        } catch {
            throw DocSendDiagnostics.createError(
                "NETWORK_REQUEST_FAILED",
                "The request was blocked or unavailable. Possible causes include network failure, CORS, or a redirect."
            );
        }
        if (!response.ok) {
            throw DocSendDiagnostics.createError("HTTP_ERROR", "The server rejected the download request.", {
                httpStatus: response.status
            });
        }
        return response;
    };

    const fetchSlideMetadata = async (pageUrl, slideNumber) => {
        if (!isDocSendPage(pageUrl) || !Number.isSafeInteger(slideNumber) || slideNumber < 1) {
            throw DocSendDiagnostics.createError("INVALID_SLIDE_REQUEST", "A valid DocSend page and slide number are required.");
        }

        const url = new URL(pageUrl);
        url.pathname = `${url.pathname.replace(/\/+$/, "")}/page_data/${slideNumber}`;
        url.search = "";
        url.hash = "";
        // Authentication is needed only for metadata on the current DocSend origin.
        const response = await fetchReadOnly(url.href, "same-origin");
        try {
            return await response.json();
        } catch {
            throw DocSendDiagnostics.createError("INVALID_METADATA", "The server returned invalid slide metadata.");
        }
    };

    const fetchSlideImage = async (imageUrl) => {
        const response = await fetchReadOnly(validateImageUrl(imageUrl), "omit");
        try {
            return await response.blob();
        } catch {
            throw DocSendDiagnostics.createError("IMAGE_READ_FAILED", "The slide image response could not be read.");
        }
    };

    return Object.freeze({isDocSendPage, validateImageUrl, fetchSlideMetadata, fetchSlideImage});
})();
