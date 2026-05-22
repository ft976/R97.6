import { createExpressApp } from "../server";

let cachedApp: any = null;

export default async function handler(req: any, res: any) {
  try {
    if (!cachedApp) {
      console.log("[Vercel] Initializing Express app...");
      cachedApp = await createExpressApp();
    }
    return cachedApp(req, res);
  } catch (err: any) {
    console.error("[Vercel] Failed to initialize app:", err);
    res.status(500).json({ error: "Initialization failed", detail: err.message });
  }
}
