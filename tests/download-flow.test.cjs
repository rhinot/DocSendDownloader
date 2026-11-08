const test = require("node:test");
const assert = require("node:assert/strict");
const {source, fixture, downloadHarness} = require("./helpers.cjs");

const imageResponse = () => ({ok: true, status: 200, blob: async () => new Blob([fixture], {type: "image/png"})});
const metadataResponse = (imageUrl = "https://fixture.cloudfront.net/slide?signature=IMAGE_SECRET") =>
    ({ok: true, status: 200, json: async () => ({imageUrl})});
const diagnostics = (harness) => harness.logs.map((entry) => entry[1]);

test("the complete flow creates a local two-page PDF using only protected GETs", async () => {
    const harness = downloadHarness();
    assert.deepEqual(harness.infos, [["[DocSend Downloader] Loaded version", JSON.parse(source("manifest.json")).version]]);
    harness.send();
    await harness.idle();
    await harness.assertPdf();
    assert.equal(harness.requests.length, 4);
    for (const {url, options} of harness.requests) {
        assert.equal(options.method, "GET");
        assert.equal(options.body, undefined);
        assert.equal(options.referrerPolicy, "no-referrer");
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, url.includes("/page_data/") ? "same-origin" : "omit");
        assert.ok(!url.includes("PAGE_SECRET"));
    }
    assert.match(harness.downloads[0].href, /^blob:/);
    assert.equal(harness.logs.length, 0);
    harness.send("CHECK_PROGRESS");
    await harness.idle();
    assert.equal(harness.requests.length, 4, "completed downloads are not repeated");
});

test("an unapproved metadata image URL stops the job before any image is requested", async () => {
    const harness = downloadHarness({respond: async () => metadataResponse("https://collector.example/receive?private=SECRET")});
    harness.send();
    await harness.idle();
    assert.equal(harness.requests.length, 1);
    assert.ok(harness.requests.every(({url}) => url.includes("/page_data/")));
    assert.equal(harness.downloads.length, 0);
    assert.equal(diagnostics(harness)[0].code, "HOST_BLOCKED");
    assert.equal(diagnostics(harness)[0].operation, "metadata");
    assert.equal(diagnostics(harness)[0].slideNumber, 1);
    assert.doesNotMatch(JSON.stringify(harness.logs), /SECRET|collector\.example/);
});

test("an image HTTP failure reports its slide and status; retry produces a fresh PDF", async () => {
    let failing = true, imageRequests = 0;
    const harness = downloadHarness({respond: async (url) => {
        if (url.includes("/page_data/")) return metadataResponse();
        imageRequests++;
        if (failing && imageRequests === 2) return {ok: false, status: 403};
        return imageResponse();
    }});
    harness.send();
    await harness.idle();
    assert.equal(harness.downloads.length, 0);
    assert.equal(diagnostics(harness).length, 1, "failure is logged once at its most specific operation");
    assert.equal(diagnostics(harness)[0].code, "HTTP_ERROR");
    assert.equal(diagnostics(harness)[0].httpStatus, 403);
    assert.equal(diagnostics(harness)[0].slideNumber, 2);
    assert.equal(diagnostics(harness)[0].operation, "image");
    failing = false;
    harness.send("CHECK_PROGRESS");
    await harness.idle();
    await harness.assertPdf();
});

test("metadata authentication errors and malformed JSON produce useful local diagnostics", async (t) => {
    for (const [respond, code] of [
        [async () => ({ok: false, status: 401}), "HTTP_ERROR"],
        [async () => ({ok: true, json: async () => {throw new SyntaxError("SECRET");}}), "INVALID_METADATA"]
    ]) await t.test(code, async () => {
        const harness = downloadHarness({respond});
        harness.send();
        await harness.idle();
        assert.equal(harness.downloads.length, 0);
        assert.equal(diagnostics(harness)[0].code, code);
        assert.equal(diagnostics(harness)[0].operation, "metadata");
        assert.doesNotMatch(JSON.stringify(harness.logs), /SECRET/);
    });
});

test("a blocked redirect or network failure stops the job without following a destination", async () => {
    const harness = downloadHarness({respond: async (url, options) => {
        assert.equal(options.redirect, "error");
        throw new TypeError("Failed request https://private.example/?token=SECRET");
    }});
    harness.send();
    await harness.idle();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.downloads.length, 0);
    assert.equal(diagnostics(harness)[0].code, "NETWORK_REQUEST_FAILED");
    assert.doesNotMatch(JSON.stringify(harness.logs), /SECRET|private\.example/);
});

test("invalid image bytes fail without a partial download and allow a successful retry", async () => {
    let failing = true;
    const harness = downloadHarness({respond: async (url) => {
        if (url.includes("/page_data/")) return metadataResponse();
        return failing ? {ok: true, blob: async () => new Blob(["PRIVATE_IMAGE_CONTENT"])} : imageResponse();
    }});
    harness.send();
    await harness.idle();
    assert.equal(harness.downloads.length, 0);
    assert.equal(diagnostics(harness)[0].code, "PDF_IMAGE_FAILED");
    assert.equal(diagnostics(harness)[0].slideNumber, 1);
    assert.doesNotMatch(JSON.stringify(harness.logs), /PRIVATE_IMAGE_CONTENT/);
    failing = false;
    harness.send("CHECK_PROGRESS");
    await harness.idle();
    await harness.assertPdf();
});

test("FileReader errors are logged and do not leave the job stuck", async () => {
    const harness = downloadHarness({readerFails: true});
    harness.send();
    await harness.idle();
    assert.equal(harness.downloads.length, 0);
    assert.equal(diagnostics(harness)[0].code, "IMAGE_READ_FAILED");
});

test("authentication and invalid slide counts stop the job before networking", async (t) => {
    for (const [options, code] of [
        [{authenticated: false}, "AUTHENTICATION_REQUIRED"],
        [{slideLabel: "missing"}, "INVALID_SLIDE_COUNT"],
        [{slideLabel: "0 / 0"}, "INVALID_SLIDE_COUNT"]
    ]) await t.test(code, async () => {
        const harness = downloadHarness(options);
        harness.send();
        await harness.idle();
        assert.equal(harness.requests.length, 0);
        assert.equal(harness.downloads.length, 0);
        assert.equal(diagnostics(harness)[0].code, code);
    });
});

test("duplicate clicks during generation and unknown messages cannot start extra jobs", async () => {
    const harness = downloadHarness();
    harness.send("UNKNOWN");
    assert.equal(harness.requests.length, 0);
    harness.send();
    harness.send();
    harness.send("CHECK_PROGRESS");
    await harness.idle();
    await harness.assertPdf();
    assert.equal(harness.requests.length, 4);
});
