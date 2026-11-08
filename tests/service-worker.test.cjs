const test = require("node:test");
const assert = require("node:assert/strict");
const {pathToFileURL} = require("node:url");
const path = require("node:path");
const {root} = require("./helpers.cjs");

let instance = 0;
async function workerHarness(t, options = {}) {
    const logs = [], injections = [], probes = [], connections = [];
    let onClick;
    t.mock.method(console, "error", (...args) => logs.push(args));
    const oldChrome = globalThis.chrome;
    t.after(() => {globalThis.chrome = oldChrome;});
    globalThis.chrome = {
        action: {onClicked: {addListener(listener) {onClick = listener;}}},
        runtime: {},
        scripting: {async executeScript(request) {
            if (request.func) {probes.push(request); return [{result: options.initialized === true}];}
            injections.push(request);
            if (options.inject) await options.inject(request);
            return [];
        }},
        tabs: {connect(tabId) {
            const port = {tabId, messages: [], disconnect: null,
                onDisconnect: {addListener(listener) {port.disconnect = listener;}},
                postMessage(message) {port.messages.push(message);}};
            connections.push(port);
            return port;
        }}
    };
    await import(pathToFileURL(path.join(root, "service_worker.js")).href + `?test=${++instance}`);
    return {click: (tab = {id: 1, url: "https://docsend.com/view/test"}) => onClick(tab), logs, injections, probes, connections};
}

test("the worker validates the clicked page before injecting any scripts", async (t) => {
    const harness = await workerHarness(t);
    for (const url of ["https://collector.example/", "http://docsend.com/view/test", "https://fixture.cloudfront.net/"]) {
        await harness.click({id: 1, url});
    }
    assert.equal(harness.probes.length, 0);
    assert.equal(harness.injections.length, 0);
    assert.ok(harness.logs.every((entry) => entry[1].code === "UNSUPPORTED_PAGE"));
});

test("the worker injects local policy files first and tracks connections per tab", async (t) => {
    const harness = await workerHarness(t);
    await harness.click();
    await harness.click();
    await harness.click({id: 2, url: "https://docsend.dropbox.com/view/other"});
    assert.equal(harness.injections.length, 2);
    assert.deepEqual(harness.injections[0].files.slice(0, 2), ["./src/Diagnostics.js", "./src/NetworkPolicy.js"]);
    assert.ok(harness.injections[0].files.every((file) => file.startsWith("./")));
    assert.deepEqual(harness.connections[0].messages.map((message) => message.requestType), ["GENERATE_PDF", "CHECK_PROGRESS"]);
    assert.equal(harness.connections[1].tabId, 2);
});

test("a restarted worker reconnects to initialized scripts without redeclaring them", async (t) => {
    const harness = await workerHarness(t, {initialized: true});
    await harness.click();
    assert.equal(harness.injections.length, 0);
    assert.equal(harness.connections.length, 1);
    harness.connections[0].disconnect();
    await harness.click();
    assert.equal(harness.injections.length, 0);
    assert.equal(harness.connections.length, 2);
});

test("script injection failures are logged without private URLs and can be retried", async (t) => {
    let failing = true;
    const harness = await workerHarness(t, {inject: async () => {
        if (failing) throw new Error("Cannot access https://docsend.com/private?token=SECRET");
    }});
    await harness.click();
    assert.equal(harness.logs[0][1].code, "START_FAILED");
    assert.equal(harness.logs[0][1].operation, "script-injection");
    assert.match(harness.logs[0][1].cause, /Chrome denied access/);
    assert.doesNotMatch(JSON.stringify(harness.logs), /SECRET|https:\/\//);
    failing = false;
    await harness.click();
    assert.equal(harness.connections.length, 1);
});

test("concurrent action clicks do not inject or start duplicate jobs", async (t) => {
    let release;
    const waiting = new Promise((resolve) => {release = resolve;});
    const harness = await workerHarness(t, {inject: () => waiting});
    const first = harness.click();
    await harness.click();
    release();
    await first;
    assert.equal(harness.injections.length, 1);
    assert.equal(harness.connections.length, 1);
});
