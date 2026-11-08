const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const {execFileSync} = require("node:child_process");
const {chromium} = require(process.env.DOCSEND_PLAYWRIGHT_PATH || "playwright");
const {root, source, fixture} = require("./helpers.cjs");

async function main() {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "docsend-browser-test-"));
    let context, server;
    try {
        const keyPath = path.join(profile, "fixture-key.pem");
        const certificatePath = path.join(profile, "fixture-cert.pem");
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=docsend.com", "-keyout", keyPath, "-out", certificatePath], {stdio: "ignore"});
        server = https.createServer({key: await fs.readFile(keyPath), cert: await fs.readFile(certificatePath)}, (request, response) => {
            const url = new URL(request.url, `https://${request.headers.host}`);
            const fulfill = ({status = 200, headers = {}, contentType = "text/plain", body = "", json}) => {
                response.writeHead(status, {"content-type": json ? "application/json" : contentType, ...headers});
                response.end(json ? JSON.stringify(json) : body);
            };
            if (url.pathname.includes("/page_data/")) {
                if (url.pathname.includes("metadata-redirect")) return fulfill({status: 302, headers: {location: "https://collector.example/redirect-target"}});
                const slide = Number(url.pathname.split("/").at(-1));
                let imageUrl = `https://${slide === 1 ? "fixture.cloudfront.net" : "docsend.com"}/images/slide-${slide}.png?signature=fixture`;
                if (url.pathname.includes("bad-host")) imageUrl = "https://collector.example/private?token=SECRET";
                if (url.pathname.includes("image-redirect")) imageUrl = "https://fixture.cloudfront.net/images/redirect.png";
                if (url.pathname.includes("http-error")) imageUrl = "https://fixture.cloudfront.net/images/forbidden.png";
                return fulfill({json: {imageUrl}});
            }
            if (url.pathname === "/images/redirect.png") return fulfill({status: 302, headers: {location: "https://collector.example/redirect-target"}});
            if (url.pathname === "/images/forbidden.png") return fulfill({status: 403, body: "forbidden"});
            if (url.pathname.startsWith("/images/") || url.pathname === "/cors-probe") {
                return fulfill({contentType: "image/png", body: fixture,
                    headers: {"access-control-allow-origin": "https://denied.invalid"}});
            }
            return fulfill({contentType: "text/html", headers: {"Referrer-Policy": "unsafe-url"}, body: `
                <!doctype html><div class="page-label">2 / 2</div>
                <div class="row flash flash-notice"><div class="alert_content alert_content--with-close"></div></div>
                <div class="contact-card_description">"Fixture deck"</div>`});
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = `127.0.0.1:${server.address().port}`;
        const allowedHosts = ["docsend.com", "fixture.cloudfront.net", "unrelated.example"];
        const resolverRules = [...allowedHosts.map((host) => `MAP ${host} ${address}`), "MAP * ~NOTFOUND"].join(", ");
        context = await chromium.launchPersistentContext(profile, {
            executablePath: process.env.DOCSEND_CHROMIUM_PATH || chromium.executablePath(),
            headless: true,
            acceptDownloads: true,
            args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
                "--disable-background-networking", "--no-proxy-server",
                "--ignore-certificate-errors", `--host-resolver-rules=${resolverRules}`]
        });
        const requests = [], logs = [];
        await context.addCookies([
            {name: "audit_session", value: "fixture", domain: "docsend.com", path: "/", secure: true},
            {name: "cdn_session", value: "fixture", domain: "fixture.cloudfront.net", path: "/", secure: true, sameSite: "None"}
        ]);
        // Recognized hosts resolve only to our local HTTPS server. All other HTTP requests are aborted.
        await context.route("**/*", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (!["https:", "http:"].includes(url.protocol)) return route.continue();
            requests.push({url: url.href, method: request.method(), body: request.postData(), headers: await request.allHeaders()});
            if (!allowedHosts.includes(url.hostname)) return route.abort();
            return route.continue();
        });

        const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", {timeout: 15000});
        assert.match(worker.url(), /^chrome-extension:\/\//);
        assert.deepEqual(await worker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()), ["ruleset_1"]);
        const files = JSON.parse(source("service_worker.js").match(/const scriptsToInject = (\[[\s\S]*?\]);/)[1]);
        async function openDeck(name) {
            const page = await context.newPage();
            page.on("console", (message) => {
                if (message.text().startsWith("[DocSend Downloader]")) {
                    logs.push(Promise.all(message.args().map((arg) => arg.jsonValue())));
                }
            });
            await page.goto(`https://docsend.com/view/${name}?private=PAGE_SECRET`);
            return page;
        }
        async function start(page) {
            return worker.evaluate(async ({url, files}) => {
                const [tab] = await chrome.tabs.query({url});
                await chrome.scripting.executeScript({target: {tabId: tab.id}, files});
                const port = chrome.tabs.connect(tab.id);
                globalThis.browserTestPorts ??= [];
                globalThis.browserTestPorts.push(port);
                port.postMessage({requestType: "GENERATE_PDF"});
            }, {url: page.url(), files});
        }

        const page = await openDeck("success");
        const [download] = await Promise.all([page.waitForEvent("download", {timeout: 15000}), start(page)]);
        const pdf = await fs.readFile(await download.path());
        assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
        assert.match(pdf.toString("latin1"), /\/Count 2\b/);
        const downloadRequests = requests.filter(({url}) => url.includes("/page_data/") || url.includes("/images/"));
        assert.equal(downloadRequests.length, 4);
        for (const request of downloadRequests) {
            assert.equal(request.method, "GET");
            assert.equal(request.body, null);
            assert.equal(request.headers.referer, undefined);
            assert.ok(!request.url.includes("PAGE_SECRET"));
            if (request.url.includes("/page_data/")) assert.match(request.headers.cookie || "", /audit_session=fixture/);
            else assert.equal(request.headers.cookie, undefined);
        }
        console.log("PASS: Chrome loads the ruleset and produces a two-page PDF; headers confirm GET-only requests, no referrers, metadata-only cookies.");

        const corsProbe = (page, method = "GET") => page.evaluate(async (method) => {
            try {
                await fetch("https://fixture.cloudfront.net/cors-probe", {method, credentials: "omit"});
                return "allowed";
            } catch {return "blocked";}
        }, method);
        assert.equal(await corsProbe(page), "allowed");
        assert.equal(await corsProbe(page, "POST"), "blocked");
        const unrelated = await context.newPage();
        await unrelated.goto("https://unrelated.example/");
        assert.equal(await corsProbe(unrelated), "blocked");
        console.log("PASS: the CORS exception applies to DocSend GETs, and excludes unrelated pages and POST responses.");

        for (const name of ["bad-host", "metadata-redirect", "image-redirect", "http-error"]) {
            const failingPage = await openDeck(name);
            await start(failingPage);
            await failingPage.waitForFunction(() => document.querySelector(".alert_content--with-close").textContent.includes("Unable to download"));
        }
        assert.ok(!requests.some(({url}) => url.includes("collector.example")));
        // Keep pages alive until their console argument handles have been read.
        const entries = (await Promise.all(logs)).map((entry) => entry[1]);
        assert.ok(entries.includes(JSON.parse(source("manifest.json")).version), "the console reports the loaded manifest version");
        assert.ok(entries.some((entry) => entry.code === "HOST_BLOCKED"));
        assert.equal(entries.filter((entry) => entry.code === "NETWORK_REQUEST_FAILED").length, 2);
        assert.ok(entries.some((entry) => entry.code === "HTTP_ERROR" && entry.httpStatus === 403));
        assert.doesNotMatch(JSON.stringify(entries), /SECRET|signature|https:\/\//);
        console.log("PASS: unapproved hosts and both redirect paths make zero requests to their target; HTTP failures and redacted diagnostics are verified in Chrome.");
    } finally {
        await context?.close();
        if (server) await new Promise((resolve) => server.close(resolve));
        await fs.rm(profile, {recursive: true, force: true});
    }
}

main().catch((error) => {console.error(error); process.exitCode = 1;});
