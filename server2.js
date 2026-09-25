import cluster from "cluster";
import os from "os";

import http from "http";
import { WebSocketServer } from "ws";
import { AssemblyAI } from "assemblyai";
import ffmpeg from "fluent-ffmpeg";
import axios from "axios";

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

const numCPUs = 2; // your Render CPUs

// =========================
// 🧠 MASTER
// =========================
if (cluster.isPrimary) {
  console.log(`🧠 Master ${process.pid} running`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {
    console.log(`❌ Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

} else {

  // =========================
  // 👇 WORKER SERVER
  // =========================

  const PORT = process.env.PORT || 8080;

  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
  });

  const wss = new WebSocketServer({ server });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Worker ${process.pid} running`);
  });

  const client = new AssemblyAI({
    apiKey: process.env.ASSEMBLYAI_API_KEY,
  });

  async function resolveStream(url) {
    try {
      const res = await axios.get(url, {
        maxRedirects: 5,
        responseType: "stream",
      });
      return res.request?.res?.responseUrl || url;
    } catch {
      return url;
    }
  }

  async function stopStreaming(state) {
    if (state.restartTimer) clearTimeout(state.restartTimer);

    if (state.audioTimer) {
        clearInterval(state.audioTimer);
        state.audioTimer = null;
    }


    try {
        if (state.recognizeStream) {
            state.recognizeStream.sendAudio(audioQueue.shift());
        }
        } catch (err) {
        console.error("sendAudio:", err.message);
    }

    if (state.ffmpegStream && state.ffmpegStream.destroy) {
        state.ffmpegStream.destroy();
        state.ffmpegStream = null;
    }

    state.isStreaming = false;
    }

  async function startStreaming(url, lang, ws, state) {
    if (state.isStreaming) return;
  
    state.isStreaming = true;
  
    console.log(`🎧 START (${process.pid})`, url);
  
    const realUrl = await resolveStream(url);
  
    const rt = client.streaming.transcriber({
      sampleRate: 16000,
      speechModel: "universal-3-5-pro",
      mode: "balanced",
    });
  
    console.log("stream() exists:", typeof rt.stream);
    console.log("Connecting to AssemblyAI...");
  
    try {
      await rt.connect();
      console.log("✅ connect() finished");
    } catch (e) {
      console.error("❌ connect() failed:", e);
      state.isStreaming = false;
      return;
    }
  
    state.recognizeStream = rt;
  
    rt.on("open", (session) => {
      console.log("AssemblyAI connected:", session);
    });
  
    rt.on("turn", (turn) => {
        if (!turn.end_of_turn) return;   // Ignore partials

        if (!turn.transcript) return;

        ws.send(JSON.stringify({
            text: turn.transcript,
            lang,
            final: true
        }));
    });
  
    rt.on("error", (err) => {
      console.error("AssemblyAI ERROR:", err);
      restartStream(url, lang, ws, state);
    });
  
    rt.on("close", (code, reason) => {
      console.log("AssemblyAI CLOSED:", code, reason);
    });
  
    
  
    const command = ffmpeg(realUrl).inputOptions([
      "-threads", "1",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-fflags", "+discardcorrupt",
      "-err_detect", "ignore_err",
      "-probesize", "500000",
      "-analyzeduration", "1000000",
      "-loglevel", "error",
    ]);
  
    state.ffmpegStream = command
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioFrequency(16000)
      .audioChannels(1)
      .format("s16le")
      .on("start", (cmd) => {
        console.log("FFmpeg:", cmd);
      })
      .on("stderr", (line) => {
        console.log("ffmpeg:", line);
      })
      .on("error", (err) => {
        console.error("FFmpeg Error:", err);
        restartStream(url, lang, ws, state);
      })
      .pipe();
  
    let audioBuffer = Buffer.alloc(0);
    const audioQueue = [];
  
    let buffer = Buffer.alloc(0);

    state.ffmpegStream.on("data", (chunk) => {
      audioBuffer = Buffer.concat([audioBuffer, chunk]);

      while (audioBuffer.length >= 3200) {
            audioQueue.push(audioBuffer.subarray(0, 3200));
            audioBuffer = audioBuffer.subarray(3200);
      }
    
    });
    state.audioTimer = setInterval(() => {
        if (!state.recognizeStream) return;

        if (audioQueue.length === 0) return;

        try {
            state.recognizeStream.sendAudio(audioQueue.shift());
        } catch (err) {
            console.error("sendAudio:", err.message);
        }
        }, 100);
      
    state.restartTimer = setTimeout(() => {
      restartStream(url, lang, ws, state);
    }, 270000);
  }

  async function restartStream(url, lang, ws, state) {
    console.log(`🔄 Restart (${process.pid})`);
  
    await stopStreaming(state);
  
    setTimeout(() => {
      startStreaming(url, lang, ws, state);
    }, 800);
  }

  wss.on("connection", (ws) => {
    console.log(`🔥 Client connected (Worker ${process.pid})`);

    if (wss.clients.size > 2) {
      ws.send(JSON.stringify({ error: "Server busy" }));
      ws.close();
      return;
    }

    const state = {
      audioTimer: null,
      recognizeStream: null,
      ffmpegStream: null,
      restartTimer: null,
      isStreaming: false,
    };

    ws.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.type === "start") {
          if (state.isStreaming && state.currentLang === data.lang) return;
        
          await stopStreaming(state);
        
          state.currentLang = data.lang;
        
          setTimeout(() => {
            startStreaming(data.url, data.lang, ws, state);
          }, 300);
        }

        if (data.type === "stop") {
          await stopStreaming(state);
        }

      } catch (err) {
        console.error("❌ Parse error:", err.message);
      }
    });

    ws.on("close", () => {
      console.log(`❌ Client disconnected (Worker ${process.pid})`);
      stopStreaming(state);
    });
  });

}