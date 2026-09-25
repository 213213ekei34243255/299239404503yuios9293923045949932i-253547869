const { app } = require("electron");
const path = require("path");

app.whenReady().then(async () => {
    try {
        const { KokoroTTS } = await import("kokoro-js");

        console.log("[KOKORO] Imported");

        const tts = await KokoroTTS.from_pretrained(
            "onnx-community/Kokoro-82M-v1.0-ONNX",
            {
                dtype: "q8",
                device: "cpu"
            }
        );

        console.log("[KOKORO] Model loaded");

        const voicePath = path.join(
            "C:\\Jonah\\node_modules\\kokoro-js",
            "voices",
            "af_heart.bin"
        );

        console.log("[KOKORO] Voice:", voicePath);
        console.log("[KOKORO] Exists:", require("fs").existsSync(voicePath));

        const audio = await tts.generate(
            "Hello Sean. This is Jonah.",
            {
                voice: "af_heart"
            }
        );

        console.log("[KOKORO] Generated:", audio.audio.length);
        console.log("[KOKORO] Rate:", audio.sampling_rate);

        await audio.save("C:\\Jonah\\kokoro-test.wav");

        console.log("[KOKORO] WAV SAVED");

        app.quit();

    } catch (err) {
        console.error("[KOKORO] FAILED:");
        console.error(err);
        app.exit(1);
    }
});