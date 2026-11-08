import "./src/Diagnostics.js";
import "./src/NetworkPolicy.js";

const connections = new Map();
const pendingInjections = new Set();

const scriptsToInject = [
    "./src/Diagnostics.js",
    "./src/NetworkPolicy.js",
    "./modules/pdfkit.js",
    "./modules/blob-stream.js",
    "./src/ModifyDocSendView.js",
    "./src/GeneratePDF.js",
    "./src/DocSendDownloader.js"
];

chrome.action.onClicked.addListener(async (tab) => {
    if (!DocSendNetworkPolicy.isDocSendPage(tab?.url) || !Number.isInteger(tab?.id)) {
        DocSendDiagnostics.logFailure(DocSendDiagnostics.createError(
            "UNSUPPORTED_PAGE", "Open an HTTPS DocSend slide deck before starting a download."
        ), {operation: "start"});
        return;
    }
    if (pendingInjections.has(tab.id)) return;
    const existingConnection = connections.get(tab.id);
    if (existingConnection) {
        try {
            existingConnection.postMessage({requestType: "CHECK_PROGRESS"});
            return;
        } catch (error) {
            connections.delete(tab.id);
            DocSendDiagnostics.logFailure(error, {
                code: "PORT_DISCONNECTED", reason: "The page connection was lost; reconnecting.", operation: "connection"
            });
        }
    }

    pendingInjections.add(tab.id);
    let operation = "script-injection";
    try {
        // The content scripts can outlive a suspended or restarted service worker.
        const [existing] = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => globalThis.DocSendDownloaderInitialized === true
        });
        if (!existing?.result) {
            await chrome.scripting.executeScript({target: {tabId: tab.id}, files: scriptsToInject});
        }
        operation = "connection";
        const connection = chrome.tabs.connect(tab.id);
        connections.set(tab.id, connection);
        connection.onDisconnect.addListener(() => {
            if (connections.get(tab.id) === connection) connections.delete(tab.id);
            if (chrome.runtime.lastError) {
                DocSendDiagnostics.logFailure(DocSendDiagnostics.createError(
                    "PORT_DISCONNECTED", "The connection to the DocSend page was closed."
                ), {operation: "connection"});
            }
        });
        connection.postMessage({requestType: "GENERATE_PDF"});
    } catch (error) {
        connections.delete(tab.id);
        DocSendDiagnostics.logFailure(error, {
            code: "START_FAILED", reason: "The extension could not start or connect to the page.", operation
        });
    } finally {
        pendingInjections.delete(tab.id);
    }
});
