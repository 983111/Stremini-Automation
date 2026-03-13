/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          STREMINI DESKTOP — CLOUDFLARE WORKER BACKEND               ║
 * ║                                                                      ║
 * ║  Model  : MBZUAI-IFM/K2-Think-v2  (fallback: MBZUAI/K2-Think-v2)   ║
 * ║  Secret : MBZUAI_API_KEY  (set via wrangler secret put)             ║
 * ║                                                                      ║
 * ║  MODES / ENDPOINTS                                                   ║
 * ║  POST /          — unified dispatcher (mode in body)                 ║
 * ║  GET  /          — health check                                      ║
 * ║                                                                      ║
 * ║  SUPPORTED MODES                                                     ║
 * ║  overlay         — floating AI layer (summarise / rewrite / explain  ║
 * ║                    selected text, extract tasks, generate replies,   ║
 * ║                    clipboard intelligence)                           ║
 * ║  automate        — desktop automation engine (email/file/clipboard/  ║
 * ║                    time/app triggers → structured workflow JSON)     ║
 * ║  write           — writing & communication intelligence (rewrite,    ║
 * ║                    tone, contracts, proposals, translation, reports) ║
 * ║  security        — desktop security layer (phishing, links, invoice, ║
 * ║                    attachments, screen scan)                         ║
 * ║  agent           — advanced agent routing (research, finance, code,  ║
 * ║                    growth, data, startup, legal, ARIA)               ║
 * ║  chat            — general conversational fallback                   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

export default {
  async fetch(request, env) {
    // ── CORS / base headers ───────────────────────────────────────────────
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
    const streamHeaders = {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    };

    // ── Pre-flight ────────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Health check ──────────────────────────────────────────────────────
    if (request.method === "GET") {
      return json(
        {
          status: "OK",
          service: "Stremini Desktop Worker",
          model: "MBZUAI-IFM/K2-Think-v2",
          modes: ["overlay", "automate", "write", "security", "agent", "chat"],
          version: "2.0.0",
        },
        200,
        jsonHeaders
      );
    }

    if (request.method !== "POST") {
      return json({ status: "ERROR", message: "Method not allowed." }, 405, jsonHeaders);
    }

    // ── Guard: API key ────────────────────────────────────────────────────
    if (!env.MBZUAI_API_KEY) {
      return json(
        { status: "ERROR", message: "Worker secret missing. Set MBZUAI_API_KEY via `wrangler secret put MBZUAI_API_KEY`." },
        500,
        jsonHeaders
      );
    }

    // ── Parse body ────────────────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ status: "ERROR", message: "Invalid JSON body." }, 400, jsonHeaders);
    }

    const {
      query: rawQuery,
      mode = "chat",
      stream = false,
      history = [],
      // overlay extras
      action,          // "summarise" | "rewrite" | "explain_code" | "extract_tasks" | "reply" | "clipboard"
      // write extras
      write_action,    // "rewrite" | "tone" | "simplify" | "proposal" | "translate" | "report"
      target_language, // for translate
      tone_target,     // for tone optimisation
      // security extras
      scan_type,       // "phishing" | "link" | "invoice" | "attachment" | "screen"
      // agent extras
      agent,           // "research" | "finance" | "code" | "growth" | "data" | "startup" | "legal" | "aria"
      // automation extras
      trigger_type,    // "email" | "file" | "clipboard" | "time" | "app"
    } = body;

    if (!rawQuery || typeof rawQuery !== "string") {
      return json({ status: "ERROR", message: "Missing or invalid `query` field." }, 400, jsonHeaders);
    }

    // ── Validate mode ─────────────────────────────────────────────────────
    const VALID_MODES = ["overlay", "automate", "write", "security", "agent", "chat"];
    const resolvedMode = VALID_MODES.includes(mode) ? mode : "chat";

    // ── Cap query ─────────────────────────────────────────────────────────
    const MAX_CHARS = 32000;
    const query =
      rawQuery.length > MAX_CHARS
        ? rawQuery.slice(0, MAX_CHARS) + "\n\n[Input truncated to 32 000 chars.]"
        : rawQuery;

    const trimmedHistory = history.slice(-10);

    // ── Build system prompt ───────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(resolvedMode, {
      action,
      write_action,
      target_language,
      tone_target,
      scan_type,
      agent,
      trigger_type,
    });

    // ── Call AI ───────────────────────────────────────────────────────────
    if (stream) {
      // Streaming path — forward SSE directly to client
      let aiStream;
      try {
        aiStream = await callAI(env.MBZUAI_API_KEY, systemPrompt, trimmedHistory, query, true);
      } catch (err) {
        return json({ status: "ERROR", message: `AI API unreachable: ${err.message}` }, 502, jsonHeaders);
      }

      if (!aiStream.ok) {
        const errBody = await aiStream.text().catch(() => "(unreadable)");
        return json(
          { status: "ERROR", message: `AI API HTTP ${aiStream.status}: ${errBody.slice(0, 400)}` },
          502,
          jsonHeaders
        );
      }

      // Pipe the upstream SSE directly to the client
      return new Response(aiStream.body, { status: 200, headers: streamHeaders });
    }

    // ── Non-streaming path ────────────────────────────────────────────────
    let aiResponse;
    try {
      aiResponse = await callAI(env.MBZUAI_API_KEY, systemPrompt, trimmedHistory, query, false);
    } catch (err) {
      return json({ status: "ERROR", message: `AI API unreachable: ${err.message}` }, 502, jsonHeaders);
    }

    if (!aiResponse.ok) {
      const errBody = await aiResponse.text().catch(() => "(unreadable)");
      return json(
        { status: "ERROR", message: `AI API HTTP ${aiResponse.status}: ${errBody.slice(0, 400)}` },
        502,
        jsonHeaders
      );
    }

    let aiData;
    try {
      aiData = await aiResponse.json();
    } catch (_) {
      return json({ status: "ERROR", message: "AI API returned non-JSON response." }, 502, jsonHeaders);
    }

    const rawMessage = aiData.choices?.[0]?.message?.content ?? "";
    if (!rawMessage) {
      return json(
        { status: "ERROR", message: "AI returned empty response. Try a shorter or simpler query." },
        200,
        jsonHeaders
      );
    }

    const cleaned = stripReasoning(rawMessage);
    if (!cleaned) {
      return json({ status: "ERROR", message: "Could not extract usable response from model output." }, 200, jsonHeaders);
    }

    // ── Route to structured extractor based on mode ───────────────────────
    return extractAndRespond(resolvedMode, cleaned, jsonHeaders);
  },
};

// ═════════════════════════════════════════════════════════════════════════════
//  SYSTEM PROMPT BUILDER
// ═════════════════════════════════════════════════════════════════════════════

function buildSystemPrompt(mode, opts = {}) {
  const PATIENCE = `IMPORTANT: Think through the problem fully before writing output. Be complete and precise. Never use placeholders like "...", "TODO", or truncated sections.`;

  const DATE = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  switch (mode) {

    // ── OVERLAY ─────────────────────────────────────────────────────────────
    case "overlay": {
      const actionMap = {
        summarise:      "Summarise the provided text into clear, concise bullet points. Preserve all key facts.",
        rewrite:        "Rewrite the provided text. Improve clarity, flow, and professionalism. Keep the original meaning exactly.",
        explain_code:   "Explain the provided code. Cover what it does, how it works, and any gotchas a developer should know.",
        extract_tasks:  "Extract all actionable tasks from the provided text. Return as a numbered list. Include owner or deadline if mentioned.",
        reply:          "Draft a professional, clear, and concise reply to the provided message. Match the formality of the original.",
        clipboard:      "Analyse the clipboard content. Identify what type of content it is, extract key information, and suggest the most useful action.",
      };
      const instruction = actionMap[opts.action] || "Process the provided content and return the most useful structured output for a desktop power user.";

      return `You are Stremini Desktop Overlay — a system-wide AI layer that assists professionals without breaking their flow.

${PATIENCE}

ACTION: ${instruction}

Wrap your output in <overlay> tags.

<overlay>
[Your complete, structured output here. Be concise but thorough. Use markdown formatting inside the tag for readability.]
</overlay>

RULES:
- Output ONLY the <overlay>…</overlay> block.
- Never ask clarifying questions. Execute the action on the provided content.
- If content type is ambiguous, state your interpretation in one sentence then proceed.`;
    }

    // ── AUTOMATE ─────────────────────────────────────────────────────────────
    case "automate": {
      const triggerDesc = {
        email:     "triggered by an incoming email",
        file:      "triggered when a file is created, modified, or downloaded",
        clipboard: "triggered by clipboard content change",
        time:      "triggered on a schedule or at a specific time",
        app:       "triggered by an application event or state change",
      }[opts.trigger_type] || "triggered by a user-defined condition";

      return `You are Stremini Desktop Automation Engine — a professional automation layer that converts natural language descriptions into structured, executable workflow definitions.

${PATIENCE}

The user wants to create an automation ${triggerDesc}.

Wrap your ENTIRE output in <automation> tags. Return a JSON workflow definition followed by a plain-English explanation.

<automation>
WORKFLOW DEFINITION
===================
\`\`\`json
{
  "workflow_id": "[unique_snake_case_id]",
  "name": "[Human readable workflow name]",
  "description": "[What this workflow does in one sentence]",
  "trigger": {
    "type": "[email | file | clipboard | time | app]",
    "config": {
      [trigger-specific configuration as key-value pairs]
    }
  },
  "conditions": [
    {
      "field": "[field to check]",
      "operator": "[contains | equals | matches | exists | gt | lt]",
      "value": "[expected value]"
    }
  ],
  "steps": [
    {
      "step": 1,
      "action": "[action name e.g. extract_data | send_email | log_to_sheet | summarise | draft_reply | notify | transform]",
      "config": {
        [action-specific parameters]
      },
      "on_error": "continue | stop | retry"
    }
  ],
  "output": {
    "type": "[notification | file | email | log | api_call]",
    "destination": "[where output goes]"
  }
}
\`\`\`

HOW IT WORKS
============
[Plain-English walkthrough of exactly what happens step by step when this automation fires.]

EXAMPLE SCENARIO
================
[A concrete real-world example showing this workflow in action with sample data.]

SETUP REQUIREMENTS
==================
[What the user needs to configure: permissions, API keys, paths, schedules, etc.]

EXTENSIONS
==========
[2-3 suggestions to make this workflow more powerful or handle edge cases.]
</automation>

RULES:
- Output ONLY the <automation>…</automation> block.
- The JSON must be valid and complete — no placeholders.
- Be specific and actionable in every field.`;
    }

    // ── WRITE ─────────────────────────────────────────────────────────────────
    case "write": {
      const writeMap = {
        rewrite:   "Rewrite this content to be clearer, more professional, and more impactful. Preserve all original meaning.",
        tone:      `Optimise the tone of this content to be ${opts.tone_target || "professional and confident"}. Keep all facts intact.`,
        simplify:  "Simplify this document or contract into plain language. Identify key obligations, rights, and risks.",
        proposal:  "Refine this proposal. Strengthen the value proposition, tighten the language, and make the call to action compelling.",
        translate: `Translate this content into ${opts.target_language || "the target language"} with natural, professional phrasing.`,
        report:    "Generate a structured, professional report from the provided information. Use clear headings, executive summary, and recommendations.",
      };
      const instruction = writeMap[opts.write_action] || "Enhance this content professionally. Improve clarity, structure, and impact.";

      return `You are Stremini Writing Intelligence — an elite communications and document specialist.

${PATIENCE}

TASK: ${instruction}

Wrap your ENTIRE output in <write> tags.

<write>
ENHANCED OUTPUT
===============
[Your fully rewritten / translated / simplified output here]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHANGES MADE
============
[Concise list of the key changes and why they improve the content]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ALTERNATIVE VERSION
===================
[An alternative treatment with a different tone or approach, if applicable]
</write>

RULES:
- Output ONLY the <write>…</write> block.
- The enhanced output must be complete — never truncated.
- Do not change factual content without flagging it.`;
    }

    // ── SECURITY ──────────────────────────────────────────────────────────────
    case "security": {
      const scanMap = {
        phishing:   "Analyse this email or message for phishing indicators.",
        link:       "Analyse this URL or link for suspicious patterns, redirect chains, or known threat indicators.",
        invoice:    "Analyse this invoice for signs of fraud: mismatched details, suspicious accounts, manipulation indicators.",
        attachment: "Analyse this attachment description or metadata for malware, macro, or social engineering risk.",
        screen:     "Analyse the provided screen content for security risks, sensitive data exposure, or suspicious activity.",
      };
      const instruction = scanMap[opts.scan_type] || "Perform a comprehensive security analysis of the provided content.";

      return `You are Stremini Desktop Security Layer — an expert cybersecurity analyst protecting business users from digital threats.

${PATIENCE}

SCAN TYPE: ${instruction}

Wrap your ENTIRE output in <security> tags.

<security>
SECURITY SCAN REPORT
====================
Date: ${DATE}
Scan Type: ${opts.scan_type || "General"}
Threat Level: [SAFE | LOW | MEDIUM | HIGH | CRITICAL]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VERDICT
=======
[One clear sentence: what this is and whether the user should proceed.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

THREAT INDICATORS FOUND
=======================
[List each suspicious indicator with its risk level and explanation.
 Format: ⚠ [Indicator] — [Why it's suspicious] — Risk: LOW/MEDIUM/HIGH
 If none found, state: ✓ No threat indicators detected.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DETAILED ANALYSIS
=================
[2-3 paragraphs of technical analysis explaining what was found and why it matters.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECOMMENDED ACTION
==================
[Precise, actionable steps the user should take right now.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SIMILAR THREATS TO WATCH
=========================
[2-3 related threat patterns the user should be aware of in this context.]
</security>

RULES:
- Output ONLY the <security>…</security> block.
- Be direct about risk levels — do not downplay genuine threats.
- If the content is clearly safe, say so plainly without false alarms.`;
    }

    // ── AGENT ─────────────────────────────────────────────────────────────────
    case "agent": {
      const agentProfiles = {
        research:  "You are the Stremini Research Agent — a world-class analyst. Deliver structured research briefs with sources, insights, and conclusions.",
        finance:   "You are the Stremini Finance Agent — an expert in financial analysis, modelling, and business intelligence. Deliver precise financial insights.",
        code:      "You are the Stremini Code Agent — an elite senior engineer. Deliver complete, production-ready code with explanations and tests.",
        growth:    "You are the Stremini Growth Agent — a go-to-market and growth expert. Deliver actionable strategies, channel plans, and growth frameworks.",
        data:      "You are the Stremini Data Intelligence Agent — a data scientist and analyst. Deliver clear analysis, visualisation recommendations, and insights.",
        startup:   "You are the Stremini Startup Agent — an experienced founder and advisor. Deliver practical, honest startup strategy and execution guidance.",
        legal:     "You are the Stremini Legal Agent — a business law specialist (non-lawyer AI advisor). Deliver clear legal context, risks, and practical options. Always advise consulting a qualified lawyer for binding decisions.",
        aria:      "You are ARIA — Stremini's personal OS agent. You are a calm, highly capable executive assistant and life optimiser. Coordinate tasks, manage priorities, and provide thoughtful personal and professional guidance.",
      };

      const profile = agentProfiles[opts.agent] || "You are the Stremini Advanced Agent — a versatile, highly capable AI specialist across all domains.";

      return `${profile}

${PATIENCE}

Wrap your ENTIRE output in <agent> tags. Structure your response clearly for a power user who values precision and speed.

<agent>
AGENT: ${(opts.agent || "general").toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Your complete, expert-level response here.

Structure it logically:
- Lead with the most critical insight or answer
- Support with analysis, evidence, or reasoning
- Close with clear next steps or recommendations

Use headers and formatting where it aids clarity.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEXT STEPS
==========
[3-5 concrete, prioritised actions the user should take]
</agent>

RULES:
- Output ONLY the <agent>…</agent> block.
- Be direct, specific, and actionable. Avoid filler.
- Depth over brevity — this user wants expert-level output.`;
    }

    // ── CHAT (default) ────────────────────────────────────────────────────────
    default:
      return `You are Stremini — a fast, intelligent desktop AI assistant built for founders, developers, and operators.

${PATIENCE}

Respond clearly and helpfully. Be concise but complete. Format with markdown where it aids readability.`;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  RESPONSE EXTRACTOR
// ═════════════════════════════════════════════════════════════════════════════

function extractAndRespond(mode, cleaned, headers) {
  const tagMap = {
    overlay:    { tag: "overlay",    status: "OVERLAY" },
    automate:   { tag: "automation", status: "AUTOMATION" },
    write:      { tag: "write",      status: "WRITE" },
    security:   { tag: "security",   status: "SECURITY" },
    agent:      { tag: "agent",      status: "AGENT" },
  };

  const entry = tagMap[mode];
  if (entry) {
    const content = extractTag(cleaned, entry.tag);
    if (content) {
      return json({ status: entry.status, mode, content }, 200, headers);
    }
  }

  // Plain-text fallback (chat mode or untagged response)
  return json({ status: "COMPLETED", mode, content: cleaned }, 200, headers);
}

// ═════════════════════════════════════════════════════════════════════════════
//  AI CALLER  — supports both streaming and non-streaming
// ═════════════════════════════════════════════════════════════════════════════

async function callAI(apiKey, systemPrompt, history, userQuery, stream = false) {
  const url = "https://api.k2think.ai/v1/chat/completions";
  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    "Content-Type": "application/json",
  };

  const buildBody = (model) =>
    JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userQuery },
      ],
      temperature: 0.15,
      max_tokens: 16384,
      stream,
    });

  // Primary model
  let res = await fetch(url, { method: "POST", headers, body: buildBody("MBZUAI-IFM/K2-Think-v2") });

  // Fallback model on non-2xx
  if (!res.ok) {
    res = await fetch(url, { method: "POST", headers, body: buildBody("MBZUAI/K2-Think-v2") });
  }

  return res;
}

// ═════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract content between <tagName>…</tagName>.
 * Uses lastIndexOf on the opening tag to skip reasoning preamble.
 * Gracefully handles truncated responses (no closing tag).
 */
function extractTag(text, tagName) {
  const open  = `<${tagName}>`;
  const close = `</${tagName}>`;

  const startIdx = text.lastIndexOf(open);
  if (startIdx === -1) return null;

  const contentStart = startIdx + open.length;
  const endIdx = text.indexOf(close, contentStart);

  const raw = endIdx === -1 ? text.slice(contentStart) : text.slice(contentStart, endIdx);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Strip <think>…</think> chain-of-thought reasoning blocks.
 * Also handles models that omit the closing tag.
 */
function stripReasoning(raw) {
  let out = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");

  if (out.includes("</think>")) {
    out = out.split("</think>").pop();
  }

  const structuralTags = ["<overlay>", "<automation>", "<write>", "<security>", "<agent>", "<code>"];
  let latestIdx = -1;
  for (const tag of structuralTags) {
    const idx = out.lastIndexOf(tag);
    if (idx > latestIdx) latestIdx = idx;
  }
  if (latestIdx !== -1) return out.slice(latestIdx).trim();

  return out.trim();
}

/** Convenience JSON response helper */
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}