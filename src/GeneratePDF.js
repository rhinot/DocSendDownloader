const getImageAsBlob = async (url) => {
    const blob = await DocSendNetworkPolicy.fetchSlideImage(url);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reader.onabort = () => reject(DocSendDiagnostics.createError(
            "IMAGE_READ_FAILED", "The slide image could not be read locally."
        ));
        reader.readAsDataURL(blob);
    });
};

const addSlidesToPDF = async (imageUrls, doc) => {
    for (let i = 0; i < imageUrls.length; i++) {
        try {
            const data = await getImageAsBlob(imageUrls[i]);
            const img = doc.openImage(data);
            doc.addPage({size: [img.width, img.height]});
            doc.image(img, 0, 0);
            showCustomAlert(`Generating slide deck as PDF: ${i + 1}/${imageUrls.length} slides complete...`);
        } catch (error) {
            DocSendDiagnostics.logFailure(error, {
                code: "PDF_IMAGE_FAILED",
                reason: "The slide image could not be decoded or added to the PDF.",
                operation: "image",
                slideNumber: i + 1
            });
            throw error;
        }
    }
};

const buildPdf = async (imageUrls) => {
    let doc;
    try {
        doc = new PDFDocument({layout: "landscape", margin: 0, autoFirstPage: false});
        const stream = doc.pipe(blobStream());
        await new Promise((resolve, reject) => {
            doc.once("error", reject);
            stream.once("error", reject);
            stream.once("finish", resolve);
            addSlidesToPDF(imageUrls, doc).then(() => doc.end()).catch(reject);
        });
        return stream.toBlobURL("application/pdf");
    } catch (error) {
        doc?.destroy();
        DocSendDiagnostics.logFailure(error, {
            code: "PDF_GENERATION_FAILED",
            reason: "The PDF could not be generated locally.",
            operation: "pdf"
        });
        throw error;
    }
};
