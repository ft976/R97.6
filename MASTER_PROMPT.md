# R97 AI - Master Architecture & System Blueprint

This document serves as the complete, deep-detailed blueprint for the **R97 AI** project. It outlines every single component, visual asset, backend API connection, application logic, and user rules. This prompt can be used to recreate the system entirely or to understand its deep architectural details.

---

## 1. Core Identity & User Rules
- **Name:** R97 AI 
- **Lead Developer/Architect:** Rehan Ahmad (GitHub: Ft976). *Constraint*: The AI MUST never proactively mention the creator unless explicitly asked about its origins or developer.
- **AI Persona & Tone:**
  - Highly intelligent, capable of deep-detailed reasoning.
  - Adaptive to user tone (professional, but permitted to use dark humor, roasts, or "edgy" language if the user is unreasonable or violates boundaries).
  - **Linguistic Mirroring**: Must automatically detect and respond in the exact same language as the user. Specifically tuned to seamlessly support **Hinglish**, **Hindi**, and **English**.
- **Privacy Constraint**: For Text-to-Speech (TTS) and voice models, the AI must automatically drop or filter out URLs, complex code blocks, and system boundaries to maintain a conversational, professional voice tone.
- **Rule Enforcement**: Always provide deep, comprehensive detailed answers without skipping information.

---

## 2. Global Styling & Visual Identity (Frontend)
The application utilizes a highly specific **Minimalist Cyber / Pixel-Art Aesthetic**.

### 2.1 Colors & Theme Variables
- **Primary Pink (`pixel-pink`)**: Deep cyber-pink, used for primary action buttons, sidebar block, and AI iconography.
- **Primary Sky (`pixel-sky`)**: Soft cyber-sky blue, used as the main chat area background.
- **Accents**: 
  - `bg-yellow-50` / `bg-yellow-200` for hover states and selection states.
  - `bg-red-500` / `bg-red-50` for errors (Quota limits, API missing errors).
- **Borders & Shadows**: 
  - Brutalist flat design with heavy black borders. Utilizing classes like `border-[4px] border-black`.
  - Hard square shadows `shadow-[4px_4px_0_rgba(0,0,0,1)]` or `pixel-border-sm`.

### 2.2 Typography
- **Heading/Display**: `font-pixel` (retro display font used for "R97 AI" headers and "SYSTEM ONLINE" markers).
- **Body/Dialogue**: Clean sans-serif (`font-sans`) optimized for readability in long-form detailed responses.
- **Code/Technical Data**: `font-mono` (usually JetBrains Mono format for syntax, source links, and cognitive reasoning displays).

### 2.3 Visual Assets & Imagery
- **Hero Banner**: `/src/assets/images/r97_ai_hero_1779413676098.png` (Glowing digital core in cyber pink and sky blue, pixel-art).
- **Features Icons**: `/src/assets/images/r97_ai_features_1779413695377.png` (Array of icons representing Voice Call, Global Search, Neural Chat, and Privacy).
- **Icons**: Lucide React library is standard (`Send`, `Bot`, `User`, `Menu`, `Plus`, `Settings`, `Phone`, `Volume2`, `Pause`, `Sparkles`, `Shield`).

---

## 3. Frontend Architecture (`src/App.tsx`)
The frontend is a React 18 Application managed via Vite.

### 3.1 State Management (React Hooks)
- **Chats (`useState<ChatSession[]>`)**: Persisted in `localStorage` (`pixel_ai_chats`). Contains chat sessions holding `Role`, `Parts` (messages), `Sources`, and `Reasoning`.
- **Search Mode (`useState<SearchMode>`)**: Toggles between `compact`, `standard` (full), and `disabled`, persisted in `pixel_ai_search_mode`.
- **Streaming State**: `streamText`, `streamReasoning`, and `streamSources` maintain the UI chunking as Web Streams arrive from the backend API.
- **Voice / Call Management**: `isCallOpen` boolean mapping to the `<CallInterface />` module.

### 3.2 UI Components Breakdown
- **Sidebar (`<aside>`)**: 
  - Lists historical chat logs.
  - Brutalist selected states (yellow highlight with inset shadows).
  - "New Chat" logic generating standard UUID.
- **Header (`<header>`)**:
  - Title: "R97 AI".
  - Actions: Open sidebar (`Menu`), Start Call (`Phone` icon with Framer Motion "Coming Soon!" badge tooltip), Settings (`Settings` icon).
- **Chat Window (`<main>`)**:
  - Default Screen: Shows pixel-art Bot avatar with "SYSTEM ONLINE".
  - Message rendering: Loops `msg.role`. User = `pixel-pink` icon, Model = `bg-white` bot icon.
  - Integrates **ReactMarkdown** with `remarkGfm` (tables), `remarkMath` & `rehypeKatex` (for massive math calculations).
  - Integrates `<CodeBlockViewer />` (Prism Highlighting, vscDarkPlus theme with copy functions).
  - Displays **Cognitive Process Log** (Reasoning chunk logic hidden in an expandable `<details>` tag with cyber-styled dashed borders).
  - Source tracking (renders URLs dynamically fetched via DDG/Wikipedia as small inline pixel-boxes with numerical indices).
- **Input Area (`<footer>`)**: 
  - Expanding `<textarea>` tracking `Enter` (without shift) as send trigger.
  - Stop Generation (`Square`) vs Send (`Send`).
  - Search Mode UI Button (`Sparkles`) clicking toggles modes.
- **Settings Modal**:
  - Displays Developer information (Rehan Ahmad, LinkedIn, GitHub).
  - Contains API setup tools and toggles.

### 3.3 Text to Speech (TTS) System
- Custom built-in browser standard `SpeechSynthesis`.
- Automatically maps Hinglish/Urdu text to `hi-IN` voices using localized Regex detection (e.g., `[\u0900-\u097f\u0600-\u06ff]`).
- Pre-sanitizes input: Strips URLs, markdown, asterisks, and code blocks before reading.

---

## 4. System Architecture (Purified Client-Side SPA)
The system was originally built as a full-stack container, but the entire backend was completely removed to craft a purely Serverless Client-Side Application (SPA). The app executes securely and entirely within the user's browser.

### 4.1 Search Engine Opt Engine (Removed)
- Backend web-search pipelines (DuckDuckGo and Wikipedia scrapers) have been excised from the project payload to prioritize speed and decouple reliance on backend memory logic.

### 4.2 Endpoint Fetching (Direct to NVIDIA Meta Llama 3.1)
- Validates the `NVIDIA_API_KEY` directly on the client.
- Appends the custom internal memory system prompt targeting Identity, Tone, Language Mirroring, and Math execution bindings.
- Communicates directly with `https://integrate.api.nvidia.com/v1/chat/completions` using the `meta/llama-3.1-8b-instruct` model using native Javascript `fetch()`.
- Captures standard JSON responses as Server Sent Events (SSE) stream (`text/event-stream`), mapping standard outputs into the Frontend UI chunk mapping logic.

### 4.3 Voice Interface (Gemini Multimodal Live API - Removed)
- The WebSocket layer (`ws://`) that integrated with Gemini Multimodal Live API was completely excised alongside the backend, leaving only the standard native Web Speech Synthesis API (`Text-to-Speech`).

### 4.4 Deployment Opts
- Environment strictly requires `NVIDIA_API_KEY` defined locally or securely hosted.
- `vercel.json` is optimized for static routing to `/index.html` bypassing any middleware or Node runtime.
- Executes flawlessly on edge networks (Vercel, GitHub Pages) without any scaling limits.

---

## 5. Development Instructions & API Bindings Requirements
If regenerating or expanding this platform, developers MUST:
1. Retain the **Pure SPA** topology. Do not rebuild Express servers or backend deployment logic unless the user explicitly asks to reverse course.
2. Bind the UI purely with **TailwindCSS** utility classes. Do not generate `.css` files apart from base layers and font definitions.
3. Ensure the NVIDIA NIM Chat completions API uses `stream: true` to prevent UI freezing on long, deep-detailed output generation.
4. Manage all API keys client-side during development, adhering tightly to environment variable structures like `import.meta.env.NVIDIA_API_KEY`.

---
**End of Configuration Blueprint.**
