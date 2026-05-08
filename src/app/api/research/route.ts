import { NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { AssemblyAI } from 'assemblyai';
import play from 'play-dl';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const YOUTUBE_COOKIE = process.env.YOUTUBE_COOKIE;

// API Key Rotator (Supports multiple keys separated by comma)
const YOUTUBE_KEYS = (process.env.YOUTUBE_API_KEY || '').split(',').map(k => k.trim());
let currentKeyIndex = 0;

const getYouTubeKey = () => YOUTUBE_KEYS[currentKeyIndex % YOUTUBE_KEYS.length];
const rotateKey = () => { currentKeyIndex++; console.log("DEBUG: Rotating YouTube API Key..."); };

// Human-like User Agents
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

async function initYouTube() {
  if (!YOUTUBE_COOKIE) return;
  const cleanCookie = YOUTUBE_COOKIE.trim().replace(/[\n\r\t]/g, '');
  
  try {
    const play = await import('play-dl');
    await play.setToken({
      youtube: {
        cookie: cleanCookie
      }
    });
    console.log("DEBUG: YouTube Auth Session Active.");
  } catch (e) {
    console.error("YouTube Auth Failed:", e.message);
  }
}

const aai = new AssemblyAI({ apiKey: ASSEMBLYAI_API_KEY });

// Curated Trusted Channels
const TRUSTED_CHANNELS = {
  mobile: ["beebomco", "Technology Gyan", "TechWiser", "Techy Pathshala", "Trakin TechEnglish", "TechBar", "Gyan Therapy", "Technical Guruji", "Tech Burner", "Techno Ruhez", "Harshit Technical", "Trakin Tech", "Pratima Adhikari", "Tamil Tech - MrTT"],
  laptop: ["Techum", "Venom's Tech", "TechWiser", "Tech Terminus", "Trakin Tech", "Techy Imran", "WiserGadget", "REVIEW SHEVIEW", "Tech Maan", "TechZonical", "Tech Burner", "Trakin TechEnglish", "Technical Guruji"]
};

// Helper: Search YouTube with high-stability fallback
async function searchYouTube(query: string, maxResults: number = 5, monthsAgo: number = 4) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsAgo);
  
  console.log(`DEBUG: Searching for [${query}]...`);

  // 1. Try yt-search (High stability, No API Key)
  try {
    const yts = await import('yt-search');
    const r = await yts.search(query);
    const videos = r.videos.slice(0, maxResults).map(v => ({
      id: v.videoId,
      title: v.title,
      channelTitle: v.author.name,
      publishedAt: v.timestamp || new Date().toISOString()
    }));
    if (videos.length > 0) return videos;
  } catch (e) {
    console.warn("yt-search failed, falling back to API...");
  }

  // 2. Fallback to YouTube API (With Key Rotation)
  const key = getYouTubeKey();
  if (!key) return [];
  
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&publishedAfter=${cutoff.toISOString()}&key=${key}`;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    
    if (data.error && data.error.reason === 'quotaExceeded') {
      rotateKey();
      return []; // Next call will use the new key
    }

    if (data.items) {
      return data.items.map((item: any) => ({
        id: item.id.videoId,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
      }));
    }
  } catch (e) {
    console.error("YouTube search error:", e);
  }
  return [];
}

// Helper: Get transcript text (with size limit)
async function getTranscript(videoId: string, charLimit: number = 8000) {
  // METHOD 1: Try native transcript first (Fast & Free)
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    return transcript.map(t => t.text).join(' ').substring(0, charLimit);
  } catch (e) {
    console.warn(`Native transcript failed for ${videoId}, attempting Audio-Listening (AssemblyAI)...`);

    // METHOD 2: Audio-Listening Fallback
    if (!ASSEMBLYAI_API_KEY) {
      console.error("Missing ASSEMBLYAI_API_KEY! Cannot listen to audio.");
      return null;
    }

    try {
      // Get direct audio stream URL using play-dl
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const streamInfo = await play.video_info(videoUrl);
      const audioUrl = streamInfo.format[streamInfo.format.length - 1].url;

      if (!audioUrl) throw new Error("Could not extract audio URL");

      const transcript = await aai.transcripts.transcribe({
        audio: audioUrl,
        language_detection: true
      });

      console.log(`Audio-Listening success for ${videoId}`);
      return transcript.text?.substring(0, charLimit) || null;
    } catch (err: any) {
      console.error(`Audio-Listening CRASHED for ${videoId}:`, err.message || err);
      return null;
    }
  }
}

// Helper: Ask the AI Brain (Groq Primary, Gemini Fallback)
async function askBrain(prompt: string, useJSON: boolean = false): Promise<any> {
  console.log(`DEBUG: Brain Active. Keys -> Groq: ${!!GROQ_API_KEY}, Gemini: ${!!GEMINI_API_KEY}`);
  
  // --- METHOD 1: GROQ (Primary) ---
  if (GROQ_API_KEY) {
    // Standard stable Groq models
    const groqModels = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "gemma2-9b-it"];
    
    for (const model of groqModels) {
      let attempts = 0;
      // Increased patience: 5 attempts for Free Tier stability
      while (attempts < 5) {
        try {
          console.log(`DEBUG: Attempting Groq (${model})...`);
          const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
              model: model,
              messages: [{ role: "user", content: prompt }],
              response_format: useJSON ? { type: "json_object" } : undefined,
              temperature: 0.1
            })
          });

          const data = await res.json();
          
          if (res.ok && data.choices?.[0]?.message?.content) {
            let text = data.choices[0].message.content;
            if (useJSON) {
              try { return JSON.parse(text); } catch (e) {
                text = text.replace(/```json/g, '').replace(/```/g, '').trim();
                return JSON.parse(text);
              }
            }
            return text;
          } 
          
          // AUTO-RETRY ON RATE LIMIT (Patience is key for free tier)
          if (res.status === 429 || data.error?.code === "rate_limit_exceeded") {
            console.warn(`DEBUG: Groq Rate Limit. Waiting 12s and retrying (Attempt ${attempts + 1}/5)...`);
            await new Promise(r => setTimeout(r, 12000));
            attempts++;
            continue;
          }

          console.error(`DEBUG: Groq ${model} API Error:`, data.error?.message || "Quota/Model Error");
          break; // Try next model
        } catch (e: any) {
          console.warn(`DEBUG: Groq ${model} exception:`, e.message);
          break;
        }
      }
    }
  }

  console.warn("Groq failed all attempts. Falling back to Gemini...");

  // --- METHOD 2: GEMINI (Fallback) ---
  const geminiModels = ["gemini-1.5-flash", "gemini-1.5-pro"];
  for (const modelName of geminiModels) {
    try {
      console.log(`DEBUG: Attempting Gemini (${modelName})...`);
      // Pacing for Gemini Free Tier
      await new Promise(r => setTimeout(r, 8000));
      // Using v1beta with full model path
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: useJSON ? { response_mime_type: "application/json" } : {}
        })
      });
      const data = await res.json();
      if (res.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        let text = data.candidates[0].content.parts[0].text;
        if (useJSON) {
          text = text.replace(/```json/g, '').replace(/```/g, '').trim();
          return JSON.parse(text);
        }
        return text;
      } else {
        console.error(`DEBUG: Gemini ${modelName} API Error:`, data.error?.message || "Unknown Error");
      }
    } catch (e) {
      console.warn(`DEBUG: Gemini ${modelName} exception.`);
    }
  }

  throw new Error("CRITICAL: All AI Brains failed. Please check your GROQ and GEMINI API keys.");
}

async function askGemini(prompt: string): Promise<any> { return askBrain(prompt); }
async function askGeminiJSON(prompt: string): Promise<any> { return askBrain(prompt, true); }

export async function POST(request: Request) {
  try {
    const { budget, category, selectedReqs, preferredCompanies, excludedBrands } = await request.json();
    const excludeQuery = excludedBrands && excludedBrands.length > 0 
      ? excludedBrands.map((b: string) => ` -"${b}"`).join('') 
      : '';
    const brands = preferredCompanies && preferredCompanies.length > 0 ? preferredCompanies.join(', ') : 'Any';
    const specs = selectedReqs ? selectedReqs.join(', ') : 'All-Rounder';

    if (!GEMINI_API_KEY || !YOUTUBE_API_KEY) {
      console.error("CRITICAL: Missing API Keys!");
      return NextResponse.json({ success: false, error: "API Keys Missing" }, { status: 500 });
    }

    console.log("--- STAGE 1: SEARCHING (MULTI-QUERY STRATEGY) ---");
    
    // 1. Multi-Search Strategy (Running 4 distinct queries to catch everything)
    const queries = [
      `best ${category} under ${budget} India comparison${excludeQuery}`,
      `top 5 ${category} under ${budget} India${excludeQuery}`,
      `top 10 ${category} under ${budget} India${excludeQuery}`,
      `best ${category} for ${budget} reviews${excludeQuery}`
    ];

    const allSearches = await Promise.all(queries.map(q => searchYouTube(q, 15, 4)));
    const allRecentVideos = Array.from(new Map(allSearches.flat().map(v => [v.id, v])).values());
    
    console.log(`Deduplicated Pool: ${allRecentVideos.length} videos.`);

    // 2. Filter for Trusted Channels
    const trustedList = category === 'mobile' ? TRUSTED_CHANNELS.mobile : TRUSTED_CHANNELS.laptop;
    let allVideos = allRecentVideos.filter(v => 
      trustedList.some(tc => v.channelTitle.toLowerCase().includes(tc.toLowerCase()))
    );

    // 3. Fallback: If trusted list is too small, add the top broad results
    if (allVideos.length < 5) {
      console.log("Trusted channel list too small, adding top results as fallback...");
      const fallbackVideos = allRecentVideos.filter(v => !allVideos.find(av => av.id === v.id)).slice(0, 15);
      allVideos = [...allVideos, ...fallbackVideos];
    }
    
    allVideos = allVideos.slice(0, 25);
    console.log(`Found ${allVideos.length} high-quality videos. Watching carefully...`);

    const summaryResults: string[] = [];
    let videosWatched = 0;

    // SEQUENTIAL PROCESSING
    for (const video of allVideos) {
      if (videosWatched >= 6) break; // Watch 6 videos extremely carefully

      console.log(`Watching video: ${video.title}`);
      // Increased charLimit to 12000 for "careful watching"
      const transcript = await getTranscript(video.id, 6000);

      if (!transcript) {
        console.warn(`Skipping ${video.title} - No transcript available to watch.`);
        continue;
      }

      videosWatched++;
      console.log(`Analyzing transcript for: ${video.title} (${videosWatched}/6)`);

      const summaryPrompt = `
Carefully analyze this video transcript: "${video.title}"
Transcript: ${transcript}

TASK: Extract every technical detail, benchmark, and the CURRENT MAY 2026 market price (₹) mentioned.
STRICT RULE: Focus ONLY on the current price today. If the reviewer says "it launched at 40k but now it is 35k," use 35k.
EXCLUDE RULE: Do NOT mention any devices from these brands: ${excludedBrands?.join(', ') || 'None'}.
Focus specifically on ${category} under ₹${budget}.
      `;

      try {
        const summary = await askGemini(summaryPrompt);
        summaryResults.push(`[Source: ${video.title}]\n${summary}`);
      } catch (e) {
        console.warn(`AI Error while watching ${video.title}`);
      }
    }

    const RefinedKnowledge = summaryResults.join('\n\n---\n\n');
    if (!RefinedKnowledge) throw new Error("Could not find any videos with watchable transcripts from the last 4 months.");

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 2: TECHNICAL SHORTLIST
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 2: SHORTLISTING ---");
    const extractPrompt = `
Based ONLY on these ${videosWatched} recent video transcripts:
${RefinedKnowledge}

TASK: Select the top 3 ${category} for ₹${budget}.
REQUIREMENT: They MUST be from the transcripts provided. 
Return ONLY the 3 device names as a comma-separated list.
    `;

    const candidateText = await askGemini(extractPrompt);
    const candidates = candidateText.split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 2).slice(0, 2); // ONLY TOP 2
    console.log("Finalists selected:", candidates);

    if (candidates.length === 0) throw new Error("No candidates found in the transcripts.");

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 3: DEEP-DIVE RESEARCH
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 3: DEEP DIVING ---");
    const reviewKnowledgeParts: string[] = [];

    for (const device of candidates) {
      console.log(`Searching for deep reviews of: ${device}`);
      const reviewVideos = await searchYouTube(`${device} India review full test`, 3, 4);
      for (const rv of reviewVideos) {
        const t = await getTranscript(rv.id, 6000); // Careful watching
        if (!t) continue;
        const p = `Watch this review carefully: "${rv.title}"\nTranscript: ${t}\nExtract deep benchmark scores, battery life, and heating issues for "${device}".`;
        try {
          const s = await askGemini(p);
          reviewKnowledgeParts.push(`=== DEEP RESEARCH: ${device} ===\nSource: ${rv.title}\n${s}`);
        } catch (e) {
          console.warn(`Deep dive failed for ${device}`);
        }
      }
    }

    const reviewKnowledge = reviewKnowledgeParts.join('\n\n');

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 4: PICK TOP 2
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 4: FILTERING TOP 2 ---");
    const top2Prompt = `
Compare these finalists based ONLY on the research transcripts:
${reviewKnowledge}

Pick the absolute TOP 2 for ₹${budget} (Focus: ${specs}).
Return ONLY 2 names comma-separated.
    `;

    const top2Text = await askGemini(top2Prompt);
    const top2 = top2Text.split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 2).slice(0, 2);
    console.log("Finalists:", top2);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 5: FINAL VERDICT
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 5: FINAL VERDICT ---");
    const finalPrompt = `
Perform a technical comparison for:
1. ${top2[0] || candidates[0]}
2. ${top2[1] || candidates[1] || candidates[0]}

    FINAL VERDICT TASK: 
    Based on all research gathered, generate a final recommendation for exactly 2 devices (Winner and Runner-up).
    
    FOR EACH DEVICE, PROVIDE A-TO-Z SPECIFICATIONS:
    - Processor (Specific chipset)
    - Display (Size, Panel Type, Refresh Rate, Peak Brightness)
    - RAM & Storage (Standard variants)
    - Battery & Charging (Capacity + Charging Speed in Watts)
    - Cameras (Main + Selfie megapixels and key features)
    - Build (Weight, Thickness, and IP rating if mentioned)
    - PRICE (Current May 2026 Market Price in ₹)

    ${useJSON ? 'Return ONLY a JSON object with this structure: { "devices": [ { "name": "", "price": "", "specs": { "processor": "", "display": "", "ram_storage": "", "battery": "", "camera_or_gpu": "" }, "pros": [], "verdict": "", "buy_link": "" } ] }' : ''}
    `;

    const result = await askGeminiJSON(finalPrompt);
    console.log("SUCCESS: Research complete.");

    return NextResponse.json({ success: true, recommendation: result });

  } catch (error: any) {
    console.error("CRITICAL API ERROR:", error.message || error);
    return NextResponse.json({ success: false, error: error.message || "Brain Overload" }, { status: 500 });
  }
}
