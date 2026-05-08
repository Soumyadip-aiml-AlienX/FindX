import { NextResponse } from 'next/server';
import { YoutubeTranscript } from 'youtube-transcript';
import { AssemblyAI } from 'assemblyai';
import play from 'play-dl';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const aai = new AssemblyAI({ apiKey: ASSEMBLYAI_API_KEY });

// Helper: Search YouTube with custom date filter
async function searchYouTube(query: string, maxResults: number = 5, monthsAgo: number = 4) {
  if (!YOUTUBE_API_KEY) return [];
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsAgo);

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&publishedAfter=${cutoff.toISOString()}&relevanceLanguage=en&regionCode=IN&key=${YOUTUBE_API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.items) {
      return data.items.map((item: any) => ({
        id: item.id.videoId,
        title: item.snippet.title,
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
    // llama-3.1-8b-instant has the highest free-tier limits on Groq
    const groqModels = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"];
    
    for (const model of groqModels) {
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
        } else {
          console.error(`DEBUG: Groq ${model} API Error:`, data.error?.message || data.error || "Quota/Model Error");
        }
      } catch (e: any) {
        console.warn(`DEBUG: Groq ${model} exception:`, e.message);
      }
    }
  }

  console.warn("Groq failed. Falling back to Gemini...");

  // --- METHOD 2: GEMINI (Fallback) ---
  // Use v1beta with the models/ prefix for maximum compatibility
  const geminiModels = ["gemini-1.5-flash", "gemini-1.5-pro"];
  for (const modelName of geminiModels) {
    try {
      console.log(`DEBUG: Attempting Gemini (${modelName})...`);
      await new Promise(r => setTimeout(r, 6000));
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
    const { budget, category, selectedReqs, preferredCompanies } = await request.json();
    const brands = preferredCompanies && preferredCompanies.length > 0 ? preferredCompanies.join(', ') : 'Any';
    const specs = selectedReqs ? selectedReqs.join(', ') : 'All-Rounder';

    if (!GEMINI_API_KEY || !YOUTUBE_API_KEY) {
      console.error("CRITICAL: Missing API Keys!");
      return NextResponse.json({ success: false, error: "API Keys Missing" }, { status: 500 });
    }

    console.log("BRAIN INITIALIZED. Searching for:", category, "Budget:", budget);

    // ─────────────────────────────────────────────────────────────────────────
    // STAGE 1: BROAD YOUTUBE SEARCH & "WATCHING"
    // ─────────────────────────────────────────────────────────────────────────
    console.log("--- STAGE 1: SEARCHING (LAST 4 MONTHS) ---");
    const currentYear = new Date().getFullYear();
    const mainQuery = `best ${category} under ${budget} India 2026 reviews comparison`;

    // STRICT 4 MONTH FILTER as requested
    const allVideos = await searchYouTube(mainQuery, 25, 4);
    console.log(`Found ${allVideos.length} recent videos. Watching carefully...`);

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

TASK: Extract every technical detail, benchmark, and Indian price (₹) mentioned.
STRICT RULE: ONLY use data from this transcript. Do NOT use your internal knowledge from 2023 or 2024.
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
    const candidates = candidateText.split(',').map((c: string) => c.trim()).filter((c: string) => c.length > 2).slice(0, 3);
    console.log("Candidates selected:", candidates);

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

Research Data: ${reviewKnowledge}

Return JSON strictly:
{
  "devices": [
    {
      "name": "Full model name",
      "price": 0,
      "release_year": "2026",
      "buy_link": "https://www.amazon.in/s?k=...",
      "specs": { "processor": "...", "display": "...", "ram_storage": "...", "battery": "...", "camera_or_gpu": "..." },
      "pros": ["...", "..."],
      "verdict": "Detailed explanation based on the research transcripts."
    }
  ]
}
    `;

    const result = await askGeminiJSON(finalPrompt);
    console.log("SUCCESS: Research complete.");

    return NextResponse.json({ success: true, recommendation: result });

  } catch (error: any) {
    console.error("CRITICAL API ERROR:", error.message || error);
    return NextResponse.json({ success: false, error: error.message || "Brain Overload" }, { status: 500 });
  }
}
