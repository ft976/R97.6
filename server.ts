import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

dotenv.config();

export async function createExpressApp() {
  const app = express();
  // We'll move the configuration inside this function

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

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

  async function searchWikipedia(query: string): Promise<{ title: string; snippet: string; uri: string }[]> {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PixelAI/1.0" }
      });
      if (!res.ok) return [];
      const data: any = await res.json();
      const results = data.query?.search || [];
      return results.slice(0, 3).map((item: any) => ({
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
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQuery)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Referer": "https://duckduckgo.com/"
        }
      });

      if (!res.ok) {
        // Fallback to simpler API if HTML scraping fails or is blocked
        const fallbackRes = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
        if (fallbackRes.ok) {
          const data: any = await fallbackRes.json();
          const results = [];
          if (data.Heading && data.AbstractURL) {
            results.push({
              title: data.Heading,
              snippet: data.AbstractText || data.Abstract,
              uri: data.AbstractURL
            });
          }
          if (data.RelatedTopics) {
            for (const topic of data.RelatedTopics.slice(0, 3)) {
              if (topic.Text && topic.FirstURL) {
                results.push({
                  title: topic.Text.split(" - ")[0] || "Search Result",
                  snippet: topic.Text,
                  uri: topic.FirstURL
                });
              }
            }
          }
          return results;
        }
        return [];
      }

      const html = await res.text();
      const results: { title: string; snippet: string; uri: string }[] = [];
      // Improved regex to capture result titles and snippets from DDG HTML
      const resultBlockRegex = /<div class="result results_links results_links_deep web-result[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g;
      let match;
      let limit = 0;
      while ((match = resultBlockRegex.exec(html)) !== null && limit < 5) {
        const block = match[1];
        const urlMatch = /href="([^"]+)"/.exec(block);
        
        if (urlMatch) {
          let uri = urlMatch[1];
          // Handle DDG proxy URLs
          if (uri.includes("uddg=")) {
            const matchUddg = /uddg=([^&]+)/.exec(uri);
            if (matchUddg) uri = decodeURIComponent(matchUddg[1]);
          }

          if (uri.startsWith("//")) uri = "https:" + uri;
          
          if (!uri.startsWith("http") || uri.includes("duckduckgo.com")) continue;

          // Extract title
          const titleMatch = /<a class="result__link_lnk[^>]*>([\s\S]*?)<\/a>/.exec(block);
          let title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "Untitled Search Result";
          
          // Extract snippet
          const snippetMatch = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
          let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
          
          if (snippet.length < 5 && !titleMatch) continue;

          results.push({
            title: title.replace(/\s+/g, " "),
            snippet: snippet.replace(/\s+/g, " "),
            uri
          });
          limit++;
        }
      }
      return results;
    } catch (err) {
      console.error(`DuckDuckGo search failed (${site || "web"}):`, err);
      return [];
    }
  }

  app.post("/api/chat", async (req, res) => {
    try {
      const { parts, historyContext = [], searchMode = "compact" } = req.body;

      if (!parts || parts.length === 0) {
        return res.status(400).json({ error: "Message parts are required." });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      // Extract text content to search for real-time information
      const userTextQuery = parts.find((p: any) => p.text)?.text || "";
      let collectedSources: { uri: string; title: string }[] = [];
      let searchContextText = "";

      if (searchMode !== "disabled" && userTextQuery && userTextQuery.trim().length > 2) {
        console.log(`[Search] Initiating ${searchMode} search for: ${userTextQuery}`);
        
        try {
          const [wikipediaResults, ddgResults, redditResults] = await Promise.all([
            searchWikipedia(userTextQuery),
            searchDuckDuckGo(userTextQuery),
            searchDuckDuckGo(userTextQuery, "reddit.com") // Site-specific Reddit search
          ]);

          let finalWiki = wikipediaResults;
          let finalDdg = ddgResults;
          let finalReddit = redditResults;

          // PERFECT MODE LOGIC
          if (searchMode === "compact") {
            // Compact Mode: 1 source total, very brief snippet
            // Prioritize Wikipedia > Reddit > DDG
            if (wikipediaResults.length > 0) {
              finalWiki = [wikipediaResults[0]];
              finalDdg = [];
              finalReddit = [];
            } else if (redditResults.length > 0) {
              finalWiki = [];
              finalReddit = [redditResults[0]];
              finalDdg = [];
            } else if (ddgResults.length > 0) {
              finalWiki = [];
              finalReddit = [];
              finalDdg = [ddgResults[0]];
            }
            
            const truncate = (r: any) => ({ ...r, snippet: r.snippet.slice(0, 200) + (r.snippet.length > 200 ? "..." : "") });
            finalWiki = finalWiki.map(truncate);
            finalDdg = finalDdg.map(truncate);
            finalReddit = finalReddit.map(truncate);
          } else {
            // Standard/Full Mode: Max 2 results from each source for balanced context
            finalWiki = wikipediaResults.slice(0, 2);
            finalDdg = ddgResults.slice(0, 2);
            finalReddit = redditResults.slice(0, 2);
          }

          const merged = [...finalWiki, ...finalReddit, ...finalDdg];
          const seenUris = new Set<string>();
          const uniqueResults = [];

          for (const r of merged) {
            if (!seenUris.has(r.uri)) {
              seenUris.add(r.uri);
              uniqueResults.push(r);
            }
          }

          if (uniqueResults.length > 0) {
            searchContextText = `### REAL-TIME WEB INTELLIGENCE (${searchMode.toUpperCase()} MODE)\n`;
            searchContextText += `Information retrieved from live sources (Wiki, Reddit, Web):\n\n`;
            
            uniqueResults.forEach((item, index) => {
              searchContextText += `[Source ${index + 1}]: ${item.title}\n`;
              searchContextText += `URL: ${item.uri}\n`;
              searchContextText += `CONTENT: ${item.snippet}\n\n`;
              collectedSources.push({ uri: item.uri, title: item.title });
            });
            
            searchContextText += `INSTRUCTION: Use these facts to give deep, accurate and detailed answers. Cite sources with [1], [2], etc.\n\n`;
          }
        } catch (searchErr) {
          console.error("Search pipeline error:", searchErr);
        }
      }

      const nvidiaApiKey = process.env.NVIDIA_API_KEY;
      if (!nvidiaApiKey || nvidiaApiKey.trim() === "") {
        throw new Error("nvidia_missing: You haven't configured your NVIDIA_API_KEY. Please set this environment variable in the outer 'Settings > Secrets' menu (the gear icon on the left-side panel of this container workspace) to continue chatting.");
      }

      // NVIDIA API Mode (Strictly runs only on your NVIDIA API as requested!)
      const openaiMessages = historyContext.map((msg: any) => {
        let content: any = [];
        const msgParts = msg.parts ? msg.parts : [{ text: msg.text || "" }];

        for (const p of msgParts) {
          if (p.text) {
            content.push({ type: "text", text: p.text });
          } else if (p.inlineData) {
            if (p.inlineData.mimeType && typeof p.inlineData.mimeType === 'string' && p.inlineData.mimeType.startsWith("image/")) {
              content.push({
                type: "image_url",
                image_url: {
                  url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
                },
              });
            } else {
              // Mark non-supported attachments as text error in parts
              content.push({ type: "text", text: `[Attachment: ${p.inlineData.name || "File"} - Unsupported file type for AI analysis]` });
            }
          }
        }

        if (content.length === 1 && content[0].type === "text") {
          content = content[0].text;
        }

        return {
          role: msg.role === "user" ? "user" : "assistant",
          content,
        };
      });

      let currentContent: any = [];
      for (const p of parts) {
        if (p.text) {
          currentContent.push({ type: "text", text: p.text });
        } else if (p.inlineData) {
          console.log("Processing attachment:", p.inlineData.name, p.inlineData.mimeType);
          if (p.inlineData.mimeType && typeof p.inlineData.mimeType === 'string' && p.inlineData.mimeType.startsWith("image/")) {
            currentContent.push({
              type: "image_url",
              image_url: {
                url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
              },
            });
          } else {
            currentContent.push({ type: "text", text: `[Attachment: ${p.inlineData.name || "File"} - Unsupported file type for AI analysis]` });
          }
        }
      }
      if (currentContent.length === 1 && currentContent[0].type === "text") {
        currentContent = currentContent[0].text;
      }
      openaiMessages.push({ role: "user", content: currentContent });

      const systemPrompt = `You are R97, a friendly, intelligent, and highly DETAILED assistant. Provide deep, comprehensive, and thorough answers.

TONE AND STYLE: 
Adapt your tone and LANGUAGE based on the user's input:
- You MUST respond in the EXACT SAME LANGUAGE and STYLE as the user's input.
- If the user talks in English, respond in English.
- If the user talks in Hindi, respond in Hindi.
- If the user talks in HINGLISH (mixed Hindi and English), you MUST respond in HINGLISH.
- This apply to ALL and ENTIRE languages. Whatever language the user uses, you MUST respond in that EXACT same language.
- Do NOT translate to another language unless the user explicitly requests you to "translate" or "speak in [another language]".
- Maintain the language's natural tone, accents, and emotional nuances.
- If the user is being humorous, witty, or playful, respond with humor and wit.
- If the user is being serious, formal, or somber, respond with seriousness and professionalism.
- DARK HUMOR & VIOLATIONS: You are allowed to use DARK HUMOR and even dirty or edgy replies when appropriate or when it fits the conversation's vibe. If a user violates rules, boundaries, is being unreasonable, or says something wrong/offensive, you are permitted (and encouraged) to respond with sharp roasts, situational 'abuse' (slang/edgy language), and even dirty remarks to handle them.
- Be thorough and informative, providing extensive details for every query.
- MATH MASTERY: You are a math expert. You can understand any mathematical language and solve complex problems accurately. Provide step-by-step solutions when asked. You MUST use LaTeX for ALL mathematical formulas without exception. Use double dollar signs ($$ formula $$) for block/centered equations and single dollar signs ($ formula $) for inline math. Strictly ensure every mathematical symbol or equation is wrapped correctly.
- For voice sessions, your vocal delivery should match the identified language and emotion perfectly.

CRITICAL IDENTITY RULE: 
STRICT PRIVACY: You must NEVER mention your creator, developer, or any personal details about Rehan Ahmad proactively. Strictly do NOT give any details about him until and unless the user explicitly and specifically asks about your origins, who created you, or who your developer is. 
Only in that specific scenario should you state:
- Developed by: Rehan Ahmad
- GitHub: https://github.com/Ft976
- LinkedIn: https://www.linkedin.com/in/rehan-ahmad-863386382?utm_source=share_via&utm_content=profile&utm_medium=member_android

STRICTLY AVOID manual credits, greetings mentioning him, or self-introductions involving your creator in standard conversation. Do not share this information with anyone directly unless they ask for it.

${searchContextText}`;

      openaiMessages.unshift({
        role: "system",
        content: systemPrompt,
      });

      const nvidiaRes = await fetch(
        "https://integrate.api.nvidia.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${nvidiaApiKey}`,
          },
          body: JSON.stringify({
            model: "meta/llama-3.1-8b-instruct",
            messages: openaiMessages,
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 4096,
            stream: true,
          }),
        },
      );

      if (!nvidiaRes.ok) {
        const errDetail = await nvidiaRes.text();
        throw new Error(`NVIDIA API Error: ${errDetail || nvidiaRes.statusText}`);
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
            if (!cleanLine) continue;
            if (cleanLine === "data: [DONE]") continue;

            if (cleanLine.startsWith("data: ")) {
              try {
                const data = JSON.parse(cleanLine.slice(6));
                const text = data.choices?.[0]?.delta?.content || "";
                const reasoning = data.choices?.[0]?.delta?.reasoning_content || "";
                if (text || reasoning) {
                  const sseData = {
                    choices: [
                      {
                        delta: {
                          content: text,
                          reasoning_content: reasoning
                        },
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(sseData)}\n\n`);
                }
              } catch (e) {
                // Partial JSON, skip parsing
              }
            }
          }
        }
      }

      // Stream the sources at the absolute end
      if (collectedSources.length > 0) {
        res.write(`data: ${JSON.stringify({ sources: collectedSources })}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error: any) {
      console.error("NVIDIA API Error:", error);
      
      let finalErrorMessage = "Error communicating with AI.";
      if (error) {
        const errMsg = String(error.message || error || "");
        if (errMsg.includes("nvidia_missing:")) {
          finalErrorMessage = errMsg;
        } else if (
          errMsg.includes("429") || 
          errMsg.includes("RESOURCE_EXHAUSTED") || 
          errMsg.includes("quota") ||
          errMsg.includes("Quota exceeded")
        ) {
          finalErrorMessage = "nvidia_quota_exceeded: You have exceeded your NVIDIA API key quota. Please verify your NVIDIA Developer account plan/billing details, or configure a valid NVIDIA_API_KEY under the developer workspace's outer gear (Settings > Secrets) menu.";
        } else if (errMsg.includes("401") || errMsg.includes("invalid") || errMsg.includes("Unauthorized") || errMsg.includes("API key not valid") || errMsg.includes("API_KEY_INVALID")) {
          finalErrorMessage = "nvidia_auth_error: Your NVIDIA_API_KEY appears to be invalid or unauthorized. Please verify the value inside 'Settings > Secrets'.";
        } else {
          // Parse JSON if possible to extract cleaner error
          try {
            const jsonStart = errMsg.indexOf("{");
            if (jsonStart !== -1) {
              const parsed = JSON.parse(errMsg.slice(jsonStart));
              if (parsed.error?.message) {
                finalErrorMessage = parsed.error.message;
              } else if (parsed.detail) {
                finalErrorMessage = parsed.detail;
              }
            } else {
              finalErrorMessage = error.message || String(error);
            }
          } catch (e) {
            finalErrorMessage = error.message || String(error);
          }
        }
      }

      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: finalErrorMessage })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: finalErrorMessage });
      }
    }
  });

  app.post("/api/tti", async (req, res) => {
    res.status(404).json({ error: "TTI disabled." });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    // In production (bundled dist/server.cjs), __dirname is the dist folder
    const distPath = __dirname;
    console.log(`[Server] Production mode active. Serving from: ${distPath}`);
    
    app.use(express.static(distPath));
    
    app.get("*", (req, res) => {
      const indexPath = path.join(distPath, "index.html");
      res.sendFile(indexPath, (err) => {
        if (err) {
          console.error("Error sending index.html:", err);
          res.status(500).send("Internal Server Error: Could not load app.");
        }
      });
    });
  }

  return app;
}

import { fileURLToPath } from 'url';

// Start server if this is the main module and NOT on Vercel
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if ((isMain || process.env.NODE_ENV !== "production") && !process.env.VERCEL) {
  createExpressApp().then(app => {
    const PORT = 3000;
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    const wss = new WebSocketServer({ server });
    wss.on("connection", async (clientWs) => {
      try {
        const key = process.env.GEMINI_API_KEY;
        if (!key) {
          clientWs.close();
          return;
        }
        const ai = new GoogleGenAI({ apiKey: key });
        // Correct the model name if it was wrong
        const session = await ai.live.connect({
          model: "gemini-2.0-flash-exp",
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
              if (audioData) {
                clientWs.send(JSON.stringify({ audio: audioData }));
              }
              if (message.serverContent?.interrupted) {
                clientWs.send(JSON.stringify({ interrupted: true }));
              }
            },
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
            },
            systemInstruction: `You are R97, an advanced AI Voice Assistant. Respond in the exact same language/style as user. Developed by Rehan Ahmad.`,
            temperature: 0.7,
            topP: 0.95,
          },
        });

        clientWs.on("message", (data) => {
          const parsed = JSON.parse(data.toString());
          if (parsed.audio) {
            session.sendRealtimeInput({
              audio: { data: parsed.audio, mimeType: "audio/pcm;rate=16000" },
            });
          }
        });
        
        clientWs.on("close", () => {
          session.close();
        });
      } catch (e) {
        console.error("Live session connection error", e);
        clientWs.close();
      }
    });
  });
}
