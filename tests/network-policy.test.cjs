const test = require("node:test");
const assert = require("node:assert/strict");
const {source, policyHarness} = require("./helpers.cjs");

test("only supported HTTPS DocSend pages can start downloads", () => {
    const {policy} = policyHarness();
    for (const host of ["docsend.com", "dropbox.docsend.com", "docsend.dropbox.com", "team.docsend.dropbox.com"]) {
        assert.equal(policy.isDocSendPage(`https://${host}/view/test`), true);
    }
    for (const value of ["http://docsend.com/view/test", "https://fixture.cloudfront.net/", "https://docsend.com.evil.example/", undefined]) {
        assert.equal(policy.isDocSendPage(value), false);
    }
});

test("unapproved and malformed image URLs are rejected before any request", async (t) => {
    const cases = [
        ["https://collector.example/slide", "HOST_BLOCKED"],
        ["https://evilcloudfront.net/slide", "HOST_BLOCKED"],
        ["https://fixture.cloudfront.net.evil.example/slide", "HOST_BLOCKED"],
        ["https://docsend.com.evil.example/slide", "HOST_BLOCKED"],
        ["https://docsend.com@collector.example/slide", "URL_CREDENTIALS_BLOCKED"],
        ["https://user:secret@fixture.cloudfront.net/slide", "URL_CREDENTIALS_BLOCKED"],
        ["https://fixture.cloudfront.net:8443/slide", "CUSTOM_PORT_BLOCKED"],
        ["http://fixture.cloudfront.net/slide", "HTTPS_REQUIRED"],
        ["data:image/png;base64,secret", "HTTPS_REQUIRED"],
        ["blob:https://docsend.com/private", "HTTPS_REQUIRED"],
        ["file:///private/document", "HTTPS_REQUIRED"],
        ["javascript:alert(1)", "HTTPS_REQUIRED"],
        ["//fixture.cloudfront.net/slide", "INVALID_URL"],
        ["not a URL", "INVALID_URL"], [null, "INVALID_URL"], [{}, "INVALID_URL"]
    ];
    for (const [value, code] of cases) await t.test(String(value), async () => {
        const {policy, requests} = policyHarness();
        await assert.rejects(policy.fetchSlideImage(value), (error) => error.code === code);
        assert.equal(requests.length, 0);
    });
});

test("metadata URLs exclude query strings and fragments and preserve the document path", async () => {
    const {policy, requests} = policyHarness(async () => ({ok: true, json: async () => ({imageUrl: "fixture"})}));
    for (const path of ["/view/test", "/view/test/", "/view/test///"]) {
        await policy.fetchSlideMetadata(`https://docsend.com${path}?private=SECRET#fragment`, 2);
        const {url, options} = requests.at(-1);
        assert.equal(url, "https://docsend.com/view/test/page_data/2");
        assert.equal(options.method, "GET");
        assert.equal(options.credentials, "same-origin");
        assert.equal(options.referrerPolicy, "no-referrer");
        assert.equal(options.redirect, "error");
        assert.equal(options.body, undefined);
    }
});

test("invalid metadata requests never reach the network", async () => {
    const {policy, requests} = policyHarness();
    for (const number of [0, -1, 1.5, NaN, Infinity, "1"]) {
        await assert.rejects(policy.fetchSlideMetadata("https://docsend.com/view/test", number));
    }
    await assert.rejects(policy.fetchSlideMetadata("https://collector.example/view/test", 1));
    assert.equal(requests.length, 0);
});

test("signed image URLs are preserved and receive no credentials or referrer", async () => {
    const {policy, requests} = policyHarness(async () => ({ok: true, blob: async () => new Blob()}));
    for (const host of ["fixture.cloudfront.net", "docsend.com", "team.docsend.dropbox.com"]) {
        const url = `https://${host}/slide.png?signature=a%2Fb%3D&expires=123`;
        await policy.fetchSlideImage(url);
        const request = requests.at(-1);
        assert.equal(request.url, url);
        assert.equal(request.options.method, "GET");
        assert.equal(request.options.credentials, "omit");
        assert.equal(request.options.referrerPolicy, "no-referrer");
        assert.equal(request.options.redirect, "error");
        assert.equal(request.options.body, undefined);
    }
});

test("HTTP, network, metadata parsing, and response reading failures have diagnostic codes", async () => {
    const cases = [
        [async () => ({ok: false, status: 403}), "fetchSlideImage", "HTTP_ERROR"],
        [async () => {throw new TypeError("private URL");}, "fetchSlideImage", "NETWORK_REQUEST_FAILED"],
        [async () => ({ok: true, json: async () => {throw new SyntaxError("private body");}}), "fetchSlideMetadata", "INVALID_METADATA"],
        [async () => ({ok: true, blob: async () => {throw new Error("private body");}}), "fetchSlideImage", "IMAGE_READ_FAILED"]
    ];
    for (const [respond, method, code] of cases) {
        const {policy} = policyHarness(respond);
        await assert.rejects(policy[method]("https://docsend.com/view/test", 1), (error) => error.code === code);
    }
});

test("local diagnostics report status and slide but redact raw exceptions and avoid duplicate logs", () => {
    const {diagnostics, logs} = policyHarness();
    const error = diagnostics.createError("HTTP_ERROR", "The server rejected the request.", {httpStatus: 401});
    diagnostics.logFailure(error, {operation: "metadata", slideNumber: 3});
    diagnostics.logFailure(error);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].httpStatus, 401);
    assert.equal(logs[0][1].slideNumber, 3);
    diagnostics.logFailure(new Error("https://docsend.com/private?token=SECRET user@example.com cookie=PRIVATE"));
    diagnostics.logFailure(new Error("Identifier 'SECRET' has already been declared at https://docsend.com/private"));
    assert.match(logs[2][1].cause, /conflicting extension scripts/);
    assert.doesNotMatch(JSON.stringify(logs), /SECRET|PRIVATE|user@example|https:\/\//);
});

test("permissions and CORS changes apply only to HTTPS GET fetches from DocSend to CloudFront", () => {
    const manifest = JSON.parse(source("manifest.json"));
    assert.ok(manifest.host_permissions.every((permission) => permission.startsWith("https://")));
    const [rule] = JSON.parse(source("rules.json"));
    assert.deepEqual(rule.condition.initiatorDomains, ["docsend.com", "docsend.dropbox.com"]);
    assert.deepEqual(rule.condition.requestDomains, ["cloudfront.net"]);
    assert.deepEqual(rule.condition.requestMethods, ["get"]);
    assert.deepEqual(rule.condition.resourceTypes, ["xmlhttprequest"]);
    assert.equal(rule.condition.urlFilter, "|https://");
    assert.equal(rule.action.responseHeaders.length, 1);
});
