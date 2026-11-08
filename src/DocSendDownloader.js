let slideDeckAlreadyDownloaded = false;
let slideDeckGenerationInProgress = false;

const getSlideImageUrls = async (numSlides) => {
    const pageUrl = window.location.href;
    const imageUrls = [];
    for (let i = 1; i <= numSlides; i++) {
        try {
            const data = await DocSendNetworkPolicy.fetchSlideMetadata(pageUrl, i);
            imageUrls.push(DocSendNetworkPolicy.validateImageUrl(data?.imageUrl));
        } catch (error) {
            DocSendDiagnostics.logFailure(error, {operation: "metadata", slideNumber: i});
            throw error;
        }
    }
    return imageUrls;
};

const generateSlideDeckPdf = async () => {
    slideDeckGenerationInProgress = true;
    const startTime = Date.now();
    try {
        const numSlides = Number.parseInt(document.getElementsByClassName("page-label")[0]?.textContent, 10);
        if (!Number.isSafeInteger(numSlides) || numSlides < 1) {
            throw DocSendDiagnostics.createError("INVALID_SLIDE_COUNT", "The slide count could not be determined.");
        }
        showCustomAlert(`Generating slide deck as PDF: 0/${numSlides} slides complete...`);
        const imageUrls = await getSlideImageUrls(numSlides);
        const blobUrl = await buildPdf(imageUrls);
        initiateDownload(blobUrl);
        slideDeckAlreadyDownloaded = true;
        showDefaultAlert(`Done! Slide deck PDF generated in ${Date.now() - startTime} ms.`);
    } catch (error) {
        DocSendDiagnostics.logFailure(error);
        showDefaultAlert("Unable to download the slide deck. Check the browser console for details, then click the extension to retry.");
    } finally {
        slideDeckGenerationInProgress = false;
        hideCustomAlert();
    }
};

chrome.runtime.onConnect.addListener((port) => {
    port.onMessage.addListener((message) => {
        if (!["GENERATE_PDF", "CHECK_PROGRESS"].includes(message.requestType)) return;
        if (document.getElementById("prompt") != null) {
            DocSendDiagnostics.logFailure(DocSendDiagnostics.createError(
                "AUTHENTICATION_REQUIRED", "Sign in to DocSend before downloading the slide deck."
            ));
            showDefaultAlert("You must be signed in to download this slide deck as a PDF.");
        } else if (slideDeckGenerationInProgress) {
            showCustomAlert("Please wait. Still generating slide deck as PDF...");
        } else if (slideDeckAlreadyDownloaded) {
            showDefaultAlert("Slide deck was already downloaded during this session. Please reload the page to download again.");
        } else {
            generateSlideDeckPdf();
        }
    });
});

globalThis.DocSendDownloaderInitialized = true;
console.info("[DocSend Downloader] Loaded version", chrome.runtime.getManifest().version);
