const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const {setTimeout: delay} = require("node:timers/promises");
const {webcrypto} = require("node:crypto");

const root = path.resolve(__dirname, "..");
const fixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfeoAAAAASUVORK5CYII=", "base64");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const load = (context, files) => files.forEach((file) => vm.runInContext(source(file), context, {filename: file}));

function policyHarness(respond = async () => ({ok: true, status: 200})) {
    const requests = [], logs = [];
    const context = vm.createContext({URL, console: {error: (...args) => logs.push(args)},
        fetch: async (url, options) => {requests.push({url, options}); return respond(url, options);}});
    load(context, ["src/Diagnostics.js", "src/NetworkPolicy.js"]);
    return {policy: context.DocSendNetworkPolicy, diagnostics: context.DocSendDiagnostics, requests, logs};
}

function downloadHarness(options = {}) {
    const requests = [], logs = [], infos = [], downloads = [], blobs = [];
    let onConnect, onMessage;
    const pageUrl = options.pageUrl || "https://docsend.com/view/test?private=PAGE_SECRET#fragment";
    const defaultImage = "https://fixture.cloudfront.net/slide.png?signature=IMAGE_SECRET";
    const respond = options.respond || (async (url) => url.includes("/page_data/")
        ? {ok: true, status: 200, json: async () => ({imageUrl: defaultImage})}
        : {ok: true, status: 200, blob: async () => new Blob([fixture], {type: "image/png"})});
    const element = (tag) => ({style: "", innerHTML: "", children: [], attributes: {},
        appendChild(child) {this.children.push(child);},
        setAttribute(key, value) {this.attributes[key] = value;},
        click() {assert.equal(tag, "a"); downloads.push({href: this.href, filename: this.attributes.download});}});
    const labels = {
        "page-label": [{textContent: options.slideLabel ?? "2 / 2"}],
        "row flash flash-notice": [element("div")],
        "alert_content alert_content--with-close": [element("div")],
        "contact-card_description": [{innerText: '"Private deck"'}],
        "contact-card_email": []
    };
    const sandbox = {Blob, ArrayBuffer, Uint8Array, Uint32Array, TextEncoder, TextDecoder,
        setTimeout, clearTimeout, setImmediate, clearImmediate, crypto: webcrypto,
        URL: class extends URL {static createObjectURL(blob) {blobs.push(blob); return `blob:https://docsend.com/${blobs.length}`;}},
        console: {error: (...args) => logs.push(args), info: (...args) => infos.push(args), warn() {}, log() {}, trace() {}},
        location: {href: pageUrl},
        document: {
            body: {firstChild: null, insertBefore() {}},
            getElementsByClassName: (key) => labels[key] || [],
            getElementById: () => options.authenticated === false ? element("div") : null,
            createElement(tag) {assert.ok(["div", "a"].includes(tag)); return element(tag);},
            get cookie() {assert.fail("The extension must not read cookies directly.");}
        },
        FileReader: class {
            readAsDataURL(blob) {
                if (options.readerFails) {queueMicrotask(() => this.onerror()); return;}
                blob.arrayBuffer().then((bytes) => {
                    this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
                    this.onload();
                }).catch(() => this.onerror());
            }
        },
        fetch: async (url, fetchOptions) => {requests.push({url, options: fetchOptions}); return respond(url, fetchOptions);},
        chrome: {runtime: {
            getManifest: () => JSON.parse(source("manifest.json")),
            onConnect: {addListener(listener) {onConnect = listener;}}
        }}
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
    const context = vm.createContext(sandbox);
    load(context, ["src/Diagnostics.js", "src/NetworkPolicy.js", "modules/pdfkit.js", "modules/blob-stream.js",
        "src/ModifyDocSendView.js", "src/GeneratePDF.js", "src/DocSendDownloader.js"]);
    onConnect({onMessage: {addListener(listener) {onMessage = listener;}}});
    return {requests, logs, infos, downloads, blobs, context,
        send: (requestType = "GENERATE_PDF") => onMessage({requestType}),
        async idle() {
            for (let i = 0; i < 400; i++) {
                if (!vm.runInContext("slideDeckGenerationInProgress", context)) return;
                await delay(5);
            }
            assert.fail("The download did not finish or report a failure.");
        },
        async assertPdf() {
            assert.equal(downloads.length, 1);
            const pdf = Buffer.from(await blobs[0].arrayBuffer());
            assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
            assert.match(pdf.toString("latin1"), /\/Count 2\b/);
        }
    };
}

module.exports = {root, source, fixture, policyHarness, downloadHarness};
