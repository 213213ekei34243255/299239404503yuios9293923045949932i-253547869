// test-kokoro-path.cjs

const path = require("path");

(async () => {
    const mod = await import("kokoro-js");

    console.log("dirname:", typeof __dirname !== "undefined" ? __dirname : undefined);
    console.log("import.meta.dirname inside test:", undefined);

    const expected = path.resolve(
        "C:\\Jonah\\node_modules\\kokoro-js\\dist",
        "../voices/af_heart.bin"
    );

    console.log("Expected voice path:", expected);
})();