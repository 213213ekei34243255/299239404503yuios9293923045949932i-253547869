const { parentPort } = require("worker_threads");

let kokoro = null;
let loading = null;

async function loadKokoro() {
    if (kokoro) {
        return kokoro;
    }

    if (!loading) {
        loading = (async () => {

            console.log("[KOKORO WORKER] Loading package...");

            const { KokoroTTS } =
                await import("kokoro-js");

            console.log(
                "[KOKORO WORKER] Package imported"
            );

            const tts =
                await KokoroTTS.from_pretrained(
                    "onnx-community/Kokoro-82M-v1.0-ONNX",
                    {
                        dtype: "q4f16",
                        device: "cpu"
                    }
                );

            console.log(
                "[KOKORO WORKER] MODEL READY"
            );

            kokoro = tts;

            parentPort.postMessage({
                type: "ready"
            });

            return tts;

        })().catch((error) => {

            console.error(
                "[KOKORO WORKER] MODEL LOAD FAILED:",
                error
            );

            parentPort.postMessage({
                type: "load-error",
                error:
                    error?.stack ||
                    error?.message ||
                    String(error)
            });

            throw error;
        });
    }

    return loading;
}


// Load immediately in background.
loadKokoro().catch(() => {});


parentPort.on("message", async (message) => {

    if (!message || message.type !== "speak") {
        return;
    }

    const requestId = message.requestId;

    try {

        console.log(
            "[KOKORO WORKER] Request:",
            message.text
        );

        const tts = await loadKokoro();

        console.log(
            "[KOKORO WORKER] Generating..."
        );

        const result =
            await tts.generate(
                String(message.text).trim(),
                {
                    voice:
                        message.voice ||
                        "af_heart",

                    speed:
                        message.speed ||
                        1
                }
            );

        console.log(
            "[KOKORO WORKER] Generated:",
            result.audio.length,
            "samples @",
            result.sampling_rate,
            "Hz"
        );

        const buffer =
            result.audio.buffer.slice(
                result.audio.byteOffset,
                result.audio.byteOffset +
                result.audio.byteLength
            );

        parentPort.postMessage(
            {
                type: "success",
                requestId,
                audio: buffer,
                sampling_rate:
                    result.sampling_rate
            },
            [buffer]
        );

    } catch (error) {

        console.error(
            "[KOKORO WORKER] GENERATION FAILED:",
            error
        );

        parentPort.postMessage({
            type: "error",
            requestId,
            error:
                error?.stack ||
                error?.message ||
                String(error)
        });
    }
});