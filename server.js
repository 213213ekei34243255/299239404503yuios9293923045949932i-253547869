
require("dotenv").config();
console.log("Gemini key loaded:", !!process.env.GEMINI_API_KEY);
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());


const trustedDomains = [
    "google.com", "youtube.com", "instagram.com",
    "facebook.com", "twitter.com", "x.com",
    "discord.com", "amazon.com", "wikipedia.org",
    "linkedin.com", "github.com", "microsoft.com",
    "apple.com", "netflix.com", "web.whatsapp.com",
    "chatgpt.com", "cogniaistudios.com",
    "bing.com","grok.com","snapchat.com",
    "tiktok.com","cloudflare.com"
];

function isTrusted(domain) {
    return trustedDomains.some(d => domain.includes(d));
}


function getBrand(domain) {
    return domain
        .replace("www.", "")
        .split(".")[0]
        .replace(/[-_]/g, " ")
        .toLowerCase();
}


function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}


async function fetchRedditAPI(query) {
    try {
        const url = `https://api.reddit.com/search?q=${encodeURIComponent(query)}&limit=15`;

        const res = await axios.get(url, {
            headers: { "User-Agent": "JonahBrowser/1.0" },
            timeout: 5000
        });

        return res.data.data.children || [];
    } catch (e) {
        console.log("Reddit blocked:", e.response?.status);
        return [];
    }
}


async function fetchViaGoogle(query) {
    try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query + " reddit")}`;

        const res = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });

        const links = [...res.data.matchAll(/https:\/\/www\.reddit\.com\/r\/[^"]+/g)]
            .map(m => m[0]);

        return links.slice(0, 5);
    } catch {
        return [];
    }
}


async function classifyWithGemini(texts) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;

        const prompt = `
Classify each text into ONE of:
SCAM, COMPLAINT, POSITIVE, IRRELEVANT

Return ONLY a JSON array.

Texts:
${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}
`;

        const res = await axios.post(
             `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            {
                contents: [{ parts: [{ text: prompt }] }]
            }
        );

        const output = res.data.candidates?.[0]?.content?.parts?.[0]?.text;

        const match = output?.match(/\[.*\]/s);
        if (!match) return null;

        return JSON.parse(match[0]);

    } catch (err) {
        console.log("Gemini failed:", err.message);
        return null;
    }
}

app.get("/trust", async (req, res) => {
    const domain = req.query.domain;
    const brand = getBrand(domain);

    try {
        
        if (isTrusted(domain)) {
            return res.json({
                score: 85,
                community: 85,
                security: "Trusted platform",
                issues: ["Widely recognized service"]
            });
        }

        
        const queries = [
            `${brand} review`,
            `${brand} experience`,
            `${brand} legit or scam`,
            `${brand} trustpilot`
        ];

        let posts = [];

        for (let q of queries) {
            const data = await fetchRedditAPI(q);
            posts.push(...data);
            await sleep(600);
        }

        
        if (posts.length === 0) {
            let links = [];

            for (let q of queries) {
                const l = await fetchViaGoogle(q);
                links.push(...l);
            }

            posts = links.map(link => ({
                data: { title: link, selftext: "" }
            }));
        }

        if (posts.length === 0) {
            return res.json({
                score: 65,
                community: 65,
                security: "No data found",
                issues: ["No discussions found"]
            });
        }


        const texts = posts
            .map(p => (p.data.title + " " + p.data.selftext).toLowerCase())
            .filter(t => t.includes(brand))
            .slice(0, 10);

        let scamCount = 0;
        let complaintCount = 0;
        let positiveCount = 0;
        let issues = [];

        const classifications = await classifyWithGemini(texts);

        if (classifications) {
            classifications.forEach(label => {
                if (label === "SCAM") {
                    scamCount++;
                    issues.push("Users report scam behavior");
                } else if (label === "COMPLAINT") {
                    complaintCount++;
                } else if (label === "POSITIVE") {
                    positiveCount++;
                }
            });
        } else {
            
            texts.forEach(text => {
                if (text.includes("scam") || text.includes("fraud")) {
                    scamCount++;
                } else if (text.includes("problem") || text.includes("refund")) {
                    complaintCount++;
                } else if (text.includes("good") || text.includes("trusted")) {
                    positiveCount++;
                }
            });
        }

        

        let score = 50;

        score -= scamCount * 15;
        score -= complaintCount * 3;
        score += positiveCount * 6;

        score = Math.max(0, Math.min(100, score));

        
        let summary = "Mixed feedback";

        if (scamCount >= 3) {
            summary = "⚠️ High scam reports detected";
        } else if (complaintCount > positiveCount) {
            summary = "Frequent complaints from users";
        } else if (positiveCount > scamCount + complaintCount) {
            summary = "Mostly positive reputation";
        }

        res.json({
            score,
            community: score,
            security: summary,
            issues: issues.length ? issues : [summary],
            breakdown: {
                scamCount,
                complaintCount,
                positiveCount,
                aiUsed: !!classifications
            }
        });

    } catch (err) {
        console.error(err);
        res.json({
            score: 50,
            community: 50,
            security: "System error",
            issues: ["Internal failure"]
        });
    }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`✅ Trust API running on port ${PORT}`);
});