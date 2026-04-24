import WebSocket, { WebSocketServer } from "ws";
import speech from "@google-cloud/speech";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegPath);

const wss = new WebSocketServer({ port: 8080 });
const client = new speech.SpeechClient();

console.log("🚀 Server running on ws://localhost:8080");
function startStreaming(url, lang, ws, state) {

    const request = {
        config: {
            encoding: "LINEAR16",
            sampleRateHertz: 16000,
            languageCode: lang || "en-US",
        },
        interimResults: false,
    };

    state.recognizeStream = client
        .streamingRecognize(request)
        .on("error", (err) => {
            console.log("⚠️ Restarting stream...");
            startStreaming(url, lang, ws, state);
        })
        .on("data", (data) => {

            const result = data.results?.[0];
            if (!result || !result.isFinal) return;

            const transcript = result.alternatives?.[0]?.transcript;

            console.log("🎤 FINAL:", transcript);

            if (transcript) {
                ws.send(JSON.stringify({
                    text: transcript,
                    lang: lang
                }));
            }
        });

    let command = ffmpeg(url);

// ✅ ONLY apply headers for RAI
    if (url.includes("rai.it")) {
        command = command.inputOptions([
            "-user_agent", "Mozilla/5.0",
            "-headers", "Referer: https://www.rai.it/\r\n"
        ]);
    }

    state.ffmpegStream = command
        .audioCodec("pcm_s16le")
        .audioFrequency(16000)
        .audioChannels(1)
        .format("s16le")
        .on("error", (err) => {
            const msg = err.message || "";

            if (
                msg.includes("Output stream closed") ||
                msg.includes("SIGKILL") ||
                msg.includes("Exiting normally")
            ) {
                console.log("⚠️ FFmpeg closed (expected)");
                return;
            }

            console.error("❌ FFMPEG REAL ERROR:", err);
        })
        .pipe(state.recognizeStream);

    // 🔥 Restart before 5 min limit
    state.restartTimer = setTimeout(() => {

        console.log("🔄 Restarting stream (5min limit)");

        if (state.recognizeStream) state.recognizeStream.destroy();

        if (state.ffmpegStream && state.ffmpegStream.destroy) {
            state.ffmpegStream.destroy();
        }

        setTimeout(() => {
            startStreaming(url, lang, ws, state);
        }, 300); // 0.3 sec delay

    }, 270000); // 4.5 minutes
}
wss.on("connection", (ws) => {
let isSwitching = false;

    console.log("🔥 Client connected");

    // ✅ STATE per connection (CORRECT PLACE)
    let state = {
        recognizeStream: null,
        ffmpegStream: null,
        restartTimer: null
    };

    ws.on("message", (msg) => {
        const data = JSON.parse(msg);

        if (data.type === "start") {

            if (isSwitching) return;
            isSwitching = true;

            const { url, lang } = data;

            console.log("🎧 START:", url);
            console.log("🌍 LANG:", lang);

            // CLEAN
            if (state.recognizeStream) {
                state.recognizeStream.destroy();
                state.recognizeStream = null;
            }

            if (state.ffmpegStream && state.ffmpegStream.destroy) {
                state.ffmpegStream.destroy();
                state.ffmpegStream = null;
            }

            if (state.restartTimer) {
                clearTimeout(state.restartTimer);
            }

            // START
            setTimeout(() => {

                startStreaming(url, lang, ws, state);

                setTimeout(() => {
                    isSwitching = false;
                }, 500);

            }, 300);

        }  // ✅ THIS WAS MISSING

        // 🛑 STOP HANDLER (outside start)
        if (data.type === "stop") {

            if (state.recognizeStream) {
                state.recognizeStream.destroy();
                state.recognizeStream = null;
            }

            if (state.ffmpegStream && state.ffmpegStream.destroy) {
                state.ffmpegStream.destroy();
                state.ffmpegStream = null;
            }

            if (state.restartTimer) {
                clearTimeout(state.restartTimer);
            }
        }

        }); // ✅ THIS LINE FIXES YOUR ERROR

        // ❌ CLIENT CLOSE
        ws.on("close", () => {
        console.log("❌ Client disconnected");

        if (state.recognizeStream) {
            state.recognizeStream.destroy();
        }

        if (state.ffmpegStream && state.ffmpegStream.destroy) {
            state.ffmpegStream.destroy();
        }

        if (state.restartTimer) {
            clearTimeout(state.restartTimer);
        }
    });
});
