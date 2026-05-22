import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

dotenv.config();

// Express app setup wrapper for both main server and Vercel function
export async function createExpressApp() {
  const app = express();

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Debug route
  app.get("/api/debug-status", (req, res) => {
    res.json({
      status: "online",
      node_env: process.env.NODE_ENV,
      has_nvidia_key: !!process.env.NVIDIA_API_KEY,
      has_gemini_key: !!process.env.GEMINI_API_KEY,
      is_vercel: !!process.env.VERCEL
    });
  });

  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI {
    if (!aiClient) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw new Error("GEMINI_API_KEY environment variable is required");
      }
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    }
    return aiClient;
  }

  app.post("/api/chat", async (req, res) => {
    const requestId = Math.random().toString(36).substring(7);
    console.log(`[API][${requestId}] /api/chat - IP: ${req.ip}`);
    try {
      const { parts, historyContext = [], searchMode = "compact" } = req.body;

      if (!parts || (Array.isArray(parts) && parts.length === 0)) {
        return res.status(400).json({ error: "Message parts are required." });
      }

      const nvidiaApiKey = process.env.NVIDIA_API_KEY;
      if (!nvidiaApiKey || nvidiaApiKey.trim().length < 10) {
        console.error(`[API][${requestId}] NVIDIA_API_KEY is missing or too short`);
        return res.status(500).json({ 
          error: "nvidia_missing: NVIDIA_API_KEY is not configured properly. Please set it in Settings > Secrets." 
        });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      let collectedSources: { uri: string; title: string }[] = [];
      let searchContextText = "";

      const userTextQuery = Array.isArray(parts) 
        ? parts.map((p: any) => p.text || "").join("\n").trim()
        : (parts.text || "");

      if (searchMode !== "disabled" && userTextQuery.length > 2) {
        try {
          console.log(`[API][${requestId}] Searching for: ${userTextQuery.slice(0, 50)}...`);
          const [wikipediaResults, ddgResults, redditResults] = await Promise.all([
            searchWikipedia(userTextQuery),
            searchDuckDuckGo(userTextQuery),
            searchDuckDuckGo(userTextQuery, "reddit.com")
          ]);

          const finalWiki = searchMode === "compact" ? wikipediaResults.slice(0, 1) : wikipediaResults.slice(0, 2);
          const finalReddit = searchMode === "compact" ? redditResults.slice(0, 1) : redditResults.slice(0, 2);
          const finalDdg = searchMode === "compact" ? ddgResults.slice(0, 1) : ddgResults.slice(0, 2);

          const seen = new Set();
          const uniqueResults = [];
          for (const r of [...finalWiki, ...finalReddit, ...finalDdg]) {
            if (!seen.has(r.uri)) {
              seen.add(r.uri);
              uniqueResults.push(r);
              collectedSources.push({ uri: r.uri, title: r.title });
            }
          }

          if (uniqueResults.length > 0) {
            searchContextText = `### WEB KNOWLEDGE CONTEXT\n${uniqueResults.map((r, i) => `[${i+1}] ${r.title}: ${r.snippet} (Source: ${r.uri})`).join("\n")}\n\n`;
          }
        } catch (e) {
          console.error(`[API][${requestId}] Search failed:`, e);
        }
      }

      const openaiMessages = historyContext.map((msg: any) => {
        const text = Array.isArray(msg.parts) 
          ? msg.parts.map((p: any) => p.text || "").join("\n")
          : (msg.text || "");
        return {
          role: msg.role === "user" ? "user" : "assistant",
          content: text
        };
      });
      
      openaiMessages.push({
        role: "user",
        content: userTextQuery
      });

      const systemPrompt = `You are R97, a math genius and highly intelligent expert assistant.
- Use LaTeX for ALL math calculations and formulas (e.g., $$ formula $$ for blocks, $ formula $ for inline).
- Respond in the EXACT same language and style as the user (English, Hindi, Hinglish, etc.).
- Tone: Professional, but you can be edgy/roasty if rules are violated.
- IDENTITY: Developed by Rehan Ahmad (only mention if explicitly asked about origins).
${searchContextText}`;

      openaiMessages.unshift({ role: "system", content: systemPrompt });

      console.log(`[API][${requestId}] Calling NVIDIA API with model: meta/llama-3.1-8b-instruct`);
      const nvidiaRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${nvidiaApiKey.trim()}`
        },
        body: JSON.stringify({
          model: "meta/llama-3.1-8b-instruct",
          messages: openaiMessages,
          temperature: 0.7,
          max_tokens: 4096,
          stream: true
        })
      });

      if (!nvidiaRes.ok) {
        const errText = await nvidiaRes.text();
        console.error(`[API][${requestId}] NVIDIA API error (${nvidiaRes.status}): ${errText}`);
        
        // If 404, maybe the integrate endpoint is down or model missing, try fallback
        if (nvidiaRes.status === 404) {
          throw new Error(`NVIDIA Model Not Found (404). This might be a temporary issue with NVIDIA's Llama 3.1 8B endpoint.`);
        }
        throw new Error(`NVIDIA API Error (${nvidiaRes.status}): ${errText || nvidiaRes.statusText}`);
      }

      const reader = nvidiaRes.body?.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine || cleanLine === "data: [DONE]") continue;

            if (cleanLine.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(cleanLine.slice(6));
                const text = parsed.choices?.[0]?.delta?.content || "";
                if (text) {
                  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
                }
              } catch (e) {
                // Ignore partial JSON
              }
            }
          }
        }
      }

      if (collectedSources.length > 0) {
        res.write(`data: ${JSON.stringify({ sources: collectedSources })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      console.log(`[API][${requestId}] Stream completed successfully`);
    } catch (error: any) {
      console.error(`[API][${requestId}] Error:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || "Internal Server Error" });
      } else {
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
      }
    }
  });


  // Vite/Static handling
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}

// Start standalone server
if (!process.env.VERCEL) {
  createExpressApp().then(app => {
    const port = 3000;
    const server = app.listen(port, "0.0.0.0", () => {
      console.log(`[Server] Running at http://localhost:${port}`);
    });

    // WebSocket for Live Calls
    const wss = new WebSocketServer({ server });
    wss.on("connection", async (ws) => {
      console.log("[WS] Client connected");
      let session: any = null;
      ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio && !session) {
            const key = process.env.GEMINI_API_KEY;
            const ai = new GoogleGenAI({ apiKey: key! });
            session = await ai.live.connect({
              model: "gemini-2.0-flash-exp",
              callbacks: {
                onmessage: (m: any) => {
                  const audio = m.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                  if (audio) ws.send(JSON.stringify({ audio }));
                }
              }
            });
          }
          if (msg.audio && session) {
            session.sendRealtimeInput({ audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" } });
          }
        } catch (e) {
          console.error("[WS] Error:", e);
        }
      });
      ws.on("close", () => {
        if (session) session.close();
      });
    });
  });
}

// Search utilities
async function searchWikipedia(query: string): Promise<{ title: string; snippet: string; uri: string }[]> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, { headers: { "User-Agent": "PixelAI/1.0" } });
    if (!res.ok) return [];
    const data: any = await res.json();
    return (data.query?.search || []).slice(0, 3).map((item: any) => ({
      title: item.title,
      snippet: item.snippet.replace(/<[^>]*>/g, ""),
      uri: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`
    }));
  } catch (err) {
    console.error("Wikipedia search failed:", err);
    return [];
  }
}

async function searchDuckDuckGo(query: string, site?: string): Promise<{ title: string; snippet: string; uri: string }[]> {
  try {
    const fullQuery = site ? `site:${site} ${query}` : query;
    // Simple JSON API fallback since scraping DDG HTML is brittle
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(fullQuery)}&format=json`);
    if (!res.ok) return [];
    const data: any = await res.json();
    const results = [];
    if (data.Heading && data.AbstractURL) {
      results.push({ title: data.Heading, snippet: data.AbstractText || data.Abstract, uri: data.AbstractURL });
    }
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, 2)) {
        if (topic.Text && topic.FirstURL) {
          results.push({ title: topic.Text.split(" - ")[0] || "Result", snippet: topic.Text, uri: topic.FirstURL });
        }
      }
    }
    return results;
  } catch (err) {
    console.error(`DuckDuckGo search failed:`, err);
    return [];
  }
}

