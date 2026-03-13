'use strict';

const os   = require('os');
const path = require('path');
const fs   = require('fs');

const GEMINI_MODEL    = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

let _geminiKey = null;
function setGeminiKey(key) { _geminiKey = key; }

const MAX_TURNS = 30;
const MAX_ACTS  = 8;

let _ctx = null;
function stopTask() { if (_ctx) _ctx.stopped = true; }

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
async function runTask(task, onStep, onDone, onError) {
  if (!_geminiKey || _geminiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    onError('Gemini API key not set. Edit src/main.js and set your GEMINI_API_KEY.');
    return;
  }

  const ctx = {
    browser: null, page: null, tabs: [],
    vars: {}, log: [], goal: task, stopped: false,
  };
  _ctx = ctx;

  try {
    onStep({ type: 'planning', message: `🧠 Planning: "${task}"` });

    const initScreenshot = await readDesktopScreenshot();
    const initPlan = await geminiPlan(task, null, initScreenshot, ctx);

    if (!initPlan?.length) {
      onError('Planner returned empty plan. Try rephrasing your task.');
      return;
    }

    onStep({ type: 'plan_ready', message: `📋 ${initPlan.length} actions planned`, plan: { steps: initPlan } });

    let pending = [...initPlan];
    let turns   = 0;

    while (turns < MAX_TURNS && !ctx.stopped) {
      turns++;
      let actCount = 0;
      let failedAt = null;

      while (pending.length > 0 && actCount < MAX_ACTS && !ctx.stopped) {
        const action = pending.shift();
        actCount++;

        onStep({
          type: 'executing',
          index: actCount,
          total: pending.length + actCount,
          message: `▶ [${actCount}] ${action.tool}(${fmtParams(action.params)})`,
          step: action,
        });

        try {
          const result = await executeAction(action, ctx, onStep);
          ctx.log.push(`✓ ${action.tool} → ${result?.output || 'ok'}`);
          if (result?.vars)   Object.assign(ctx.vars, result.vars);
          if (result?.output) onStep({ type: 'step_output', message: result.output });
          if (result?.done)   { await cleanup(ctx); onDone({ message: result.done }); return; }
          await sleep(action.delay_ms ?? 1000);
        } catch (e) {
          ctx.log.push(`✗ ${action.tool}: ${e.message}`);
          onStep({ type: 'step_error', message: `⚠ ${action.tool} failed: ${e.message}` });
          failedAt = { action, error: e.message };
          break;
        }
      }

      if (ctx.stopped) break;

      onStep({ type: 'reading_screen', message: '👁 Observing with vision…' });
      const screenshot = ctx.page
        ? await capturePageScreenshot(ctx.page)
        : await readDesktopScreenshot();
      const obs = await geminiObserve(ctx, failedAt, screenshot);
      onStep({ type: 'step_output', message: `👁 ${obs.summary}` });

      if (obs.done) { await cleanup(ctx); onDone({ message: `✅ ${obs.summary}` }); return; }

      if (obs.nextActions?.length) {
        pending = [...obs.nextActions, ...pending];
        onStep({ type: 'plan_ready', message: `🔄 ${obs.nextActions.length} new actions`, plan: { steps: obs.nextActions } });
      } else if (pending.length === 0) {
        await cleanup(ctx);
        onDone({ message: obs.summary || `✅ Done: ${task}` });
        return;
      }
    }

    await cleanup(ctx);
    if (ctx.stopped) onDone({ message: '⛔ Stopped by user.' });
    else             onDone({ message: `✅ Completed: ${task}` });

  } catch (e) {
    await cleanup(ctx);
    onError(`Agent error: ${e.message}`);
  } finally {
    _ctx = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Planner
// ─────────────────────────────────────────────────────────────────────────────
async function geminiPlan(task, pageContext, screenshot, ctx) {
  const logCtx = ctx.log.length ? `\nRECENT LOG:\n${ctx.log.slice(-8).join('\n')}` : '';
  const varCtx = Object.keys(ctx.vars).length
    ? `\nVARIABLES:\n${Object.entries(ctx.vars).map(([k, v]) => `  ${k}="${String(v).slice(0, 120)}"`).join('\n')}`
    : '';
  const pgCtx = pageContext ? `\nCURRENT PAGE:\n${pageContext.slice(0, 2000)}` : '';

  const textPrompt = `You are an elite browser automation agent. Output ONLY a valid JSON array of actions. No explanation, no markdown, no backticks.

TASK: ${task}${pgCtx}${logCtx}${varCtx}

TOOLS:
open_browser   {}                                          — launch browser. ALWAYS first.
goto_url       { "url": "https://..." }                   — navigate. must include https://
wait           { "ms": 2000 }                             — pause
read_page      {}                                         — read DOM text
click          { "selector": "CSS", "method": "css" }    — click element
type_text      { "selector": "CSS", "text": "...", "clear": true }
press_key      { "key": "Enter" }                         — keyboard key
scroll         { "direction": "down", "amount": 3 }
extract_text   { "selector": "CSS", "var": "name" }
save_to_file   { "filename": "out.txt", "content": "..." }
done           { "message": "what was done" }             — ALWAYS last step

RULES:
1. open_browser MUST be first if you need a browser
2. After goto_url always add wait(2000) then read_page
3. ChatGPT/Claude/Notion inputs are contenteditable — use selector: "#prompt-textarea" for ChatGPT
4. After typing in a chat box always press_key Enter
5. End with done action
6. Output ONLY the raw JSON array

EXAMPLE:
[
  {"tool":"open_browser","params":{}},
  {"tool":"goto_url","params":{"url":"https://chat.openai.com"}},
  {"tool":"wait","params":{"ms":3000}},
  {"tool":"read_page","params":{}},
  {"tool":"done","params":{"message":"ChatGPT opened"}}
]

JSON array for: ${task}`;

  const parts = [{ text: textPrompt }];
  if (screenshot) {
    parts.push({ inlineData: { mimeType: 'image/png', data: screenshot } });
    parts.push({ text: 'Screenshot above shows current desktop state.' });
  }

  const raw = await callGemini(parts);
  return parseJSONArray(raw, task);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Observer
// ─────────────────────────────────────────────────────────────────────────────
async function geminiObserve(ctx, failedAt, screenshot) {
  const url      = ctx.page?.url() || 'none';
  const title    = await ctx.page?.title().catch(() => '') || '';
  const failCtx  = failedAt
    ? `\nLAST FAILURE: ${failedAt.action.tool} — ${failedAt.error}`
    : '';

  const prompt = `You are a browser automation observer. Look at the screenshot and decide next steps.

GOAL: ${ctx.goal}
URL: ${url}
TITLE: ${title}
LOG:
${ctx.log.slice(-6).join('\n') || '(none)'}${failCtx}

Respond ONLY with raw JSON (no markdown, no backticks):
{
  "done": false,
  "summary": "what you see on screen",
  "nextActions": [
    {"tool":"click","params":{"selector":"#btn"}},
    {"tool":"done","params":{"message":"complete"}}
  ]
}

If goal is complete set done:true and nextActions:[].
Use tools: open_browser, goto_url, wait, read_page, click, type_text, press_key, scroll, extract_text, save_to_file, done.`;

  const parts = screenshot
    ? [{ inlineData: { mimeType: 'image/png', data: screenshot } }, { text: prompt }]
    : [{ text: prompt }];

  try {
    const raw   = await callGemini(parts);
    const clean = raw.replace(/```[\w]*\n?/gm, '').replace(/```/gm, '').trim();
    const m     = clean.match(/\{[\s\S]*\}/);
    if (m) {
      const obs = JSON.parse(m[0]);
      return {
        done:        !!obs.done,
        summary:     obs.summary || title || url,
        nextActions: obs.nextActions || [],
      };
    }
  } catch (_) {}

  return { done: false, summary: `On: ${title || url}`, nextActions: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini API
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(parts, retries = 2) {
  const url  = `${GEMINI_ENDPOINT}?key=${_geminiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
  });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        if (res.status === 429 && attempt < retries) { await sleep(3000 * (attempt + 1)); continue; }
        throw new Error(`Gemini HTTP ${res.status}: ${err.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) throw new Error('Gemini returned empty response');
      return text;
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(2000);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshots
// ─────────────────────────────────────────────────────────────────────────────
async function capturePageScreenshot(page) {
  try {
    const buf = await page.screenshot({ type: 'png', fullPage: false, timeout: 8000 });
    return buf.toString('base64');
  } catch (_) { return null; }
}

async function readDesktopScreenshot() {
  try {
    const tmpPath = path.join(os.tmpdir(), 'stremini_screen.png');
    if (fs.existsSync(tmpPath)) {
      return fs.readFileSync(tmpPath).toString('base64');
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON parser
// ─────────────────────────────────────────────────────────────────────────────
function parseJSONArray(content, task) {
  if (!content) return buildFallbackPlan(task);
  let clean = content.replace(/```[\w]*\n?/gm, '').replace(/```/gm, '').trim();

  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start !== -1 && end !== -1) {
    try {
      const arr = JSON.parse(clean.slice(start, end + 1));
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (_) {}
  }

  try {
    const arr = JSON.parse(clean);
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch (_) {}

  // Last resort: regex-extract individual objects
  const actions = [];
  const re = /\{"tool"\s*:\s*"[^"]+?"[\s\S]*?\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    try { actions.push(JSON.parse(m[0])); } catch (_) {}
  }
  if (actions.length > 0) return actions;

  return buildFallbackPlan(task);
}

function buildFallbackPlan(task) {
  const urlMatch = task.match(/https?:\/\/\S+/);
  const url = urlMatch ? urlMatch[0] : 'https://www.google.com';
  return [
    { tool: 'open_browser', params: {} },
    { tool: 'goto_url',     params: { url } },
    { tool: 'wait',         params: { ms: 2000 } },
    { tool: 'read_page',    params: {} },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Action executor
// ─────────────────────────────────────────────────────────────────────────────
async function executeAction(action, ctx, onStep) {
  const fn = ACTIONS[action.tool];
  if (!fn) throw new Error(`Unknown tool: "${action.tool}". Valid: ${Object.keys(ACTIONS).join(', ')}`);
  return fn(action.params || {}, ctx, onStep);
}

const ACTIONS = {

  async open_browser(_, ctx) {
    if (ctx.browser) return { output: '🌐 Browser already open' };
    const { chromium } = require('playwright');

    const args = [
      '--start-maximized', '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ];
    const antiDetect = () => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    };

    const udd = getUserDataDir();

    // Strategy 1: real Chrome profile (all sites logged in)
    if (udd) {
      const lock = path.join(udd, 'SingletonLock');
      try { if (fs.existsSync(lock)) fs.unlinkSync(lock); } catch (_) {}
      try {
        const c = await chromium.launchPersistentContext(udd, {
          channel: 'chrome', headless: false, slowMo: 60,
          viewport: null, args, timeout: 25000,
        });
        ctx.page    = c.pages()[0] || await c.newPage();
        ctx.browser = { close: async () => { try { await c.close(); } catch (_) {} } };
        ctx.tabs    = [ctx.page];
        await ctx.page.addInitScript(antiDetect).catch(() => {});
        return { output: '🌐 Chrome — your profile loaded (all logins active ✓)' };
      } catch (_) {}
    }

    // Strategy 2: Chrome fresh session
    try {
      const b = await chromium.launch({ channel: 'chrome', headless: false, slowMo: 60, args });
      const p = await b.newPage();
      await p.addInitScript(antiDetect).catch(() => {});
      await p.setViewportSize({ width: 1280, height: 800 });
      ctx.browser = { close: async () => { try { await b.close(); } catch (_) {} } };
      ctx.page = p; ctx.tabs = [p];
      return { output: '🌐 Chrome (fresh session)' };
    } catch (_) {}

    // Strategy 3: bundled Chromium
    try {
      const b = await chromium.launch({ headless: false, slowMo: 60, args });
      const p = await b.newPage();
      await p.addInitScript(antiDetect).catch(() => {});
      await p.setViewportSize({ width: 1280, height: 800 });
      ctx.browser = { close: async () => { try { await b.close(); } catch (_) {} } };
      ctx.page = p; ctx.tabs = [p];
      return { output: '🌐 Chromium — if missing run: npx playwright install chromium' };
    } catch (e) {
      throw new Error('Cannot launch browser. Run: npx playwright install chromium\n' + e.message);
    }
  },

  async goto_url({ url = 'https://www.google.com' }, ctx) {
    if (!ctx.page) throw new Error('No browser — add open_browser first');
    const u = url.startsWith('http') ? url : 'https://' + url;
    await ctx.page.goto(u, { waitUntil: 'load', timeout: 45000 })
      .catch(() => ctx.page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    await ctx.page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(1200);
    const title = await ctx.page.title().catch(() => '');
    return { output: `🔗 ${u} — "${title}"` };
  },

  async read_page(_, ctx, onStep) {
    if (!ctx.page) return { output: '⚠ No page open' };
    if (onStep) onStep({ type: 'reading_screen', message: '👁 Reading page…' });
    const text  = await getPageText(ctx.page);
    const url   = ctx.page.url();
    const title = await ctx.page.title().catch(() => '');
    return {
      text,
      vars:   { page_text: text, page_url: url, page_title: title },
      output: `👁 "${title}" — ${text.length} chars`,
    };
  },

  async click({ selector, method = 'css', text: txt }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    let loc;
    if (method === 'text' || (txt && !selector))
      loc = ctx.page.getByText(txt || selector, { exact: false }).first();
    else if (method === 'placeholder')
      loc = ctx.page.getByPlaceholder(selector).first();
    else if (method === 'role')
      loc = ctx.page.getByRole('button', { name: selector })
        .or(ctx.page.getByRole('link', { name: selector })).first();
    else
      loc = ctx.page.locator(selector).first();

    await loc.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ force: false, timeout: 12000 }).catch(async () => {
      await ctx.page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('not found: ' + sel);
        el.click();
      }, selector).catch(() => { throw new Error(`Click failed: ${selector}`); });
    });
    await sleep(600);
    return { output: `🖱 Clicked: ${selector}` };
  },

  async type_text({ selector, text = '', method = 'css', clear = true }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    text = rv(text, ctx.vars);

    let loc;
    if (method === 'placeholder') loc = ctx.page.getByPlaceholder(selector).first();
    else if (method === 'label')  loc = ctx.page.getByLabel(selector).first();
    else                          loc = ctx.page.locator(selector).first();

    await loc.waitFor({ state: 'visible', timeout: 15000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});

    const isCE = await loc.evaluate(n =>
      n.isContentEditable ||
      n.getAttribute('contenteditable') === 'true' ||
      n.getAttribute('contenteditable') === ''
    ).catch(() => false);

    if (isCE) {
      await loc.click({ force: true });
      await sleep(150);
      if (clear) {
        await ctx.page.keyboard.press('Control+a');
        await sleep(80);
        await ctx.page.keyboard.press('Delete');
        await sleep(80);
      }
      await ctx.page.keyboard.type(text, { delay: 25 });
    } else {
      if (clear) await loc.fill('').catch(() => {});
      await loc.fill(text, { force: true, timeout: 10000 })
        .catch(() => loc.type(text, { delay: 30 }));
    }

    return { output: `⌨ Typed: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"` };
  },

  async press_key({ key }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    await ctx.page.keyboard.press(key);
    await sleep(500);
    return { output: `⌨ Key: ${key}` };
  },

  async scroll({ direction = 'down', amount = 3 }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    await ctx.page.mouse.wheel(0, direction === 'down' ? amount * 500 : -amount * 500);
    await sleep(500);
    return { output: `📜 Scrolled ${direction}` };
  },

  async wait({ ms = 2000 }) {
    await sleep(Math.min(ms, 30000));
    return { output: `⏳ ${ms}ms` };
  },

  async extract_text({ selector, var: varName }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    const text = await ctx.page.locator(selector).first()
      .textContent({ timeout: 8000 }).catch(() => '');
    const res = { output: `📄 "${String(text).slice(0, 80)}"` };
    if (varName) res.vars = { [varName]: (text || '').trim() };
    return res;
  },

  async save_to_file({ filename = 'stremini_output.txt', content }, ctx) {
    const text = rv(content || ctx.vars.page_text || '', ctx.vars);
    const dest = path.join(os.homedir(), 'Desktop', filename);
    fs.writeFileSync(dest, text, 'utf8');
    return { output: `💾 Saved → Desktop/${filename}` };
  },

  async done({ message = 'Task complete' }) {
    return { done: `✅ ${message}` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM text extractor
// ─────────────────────────────────────────────────────────────────────────────
async function getPageText(page) {
  try {
    return await page.evaluate(() => {
      const SKIP = new Set(['script','style','noscript','svg','head','iframe','canvas','meta','link','template']);
      const PRE  = { h1:'\n# ',h2:'\n## ',h3:'\n### ',button:'\n[BTN] ',a:'\n[LINK] ',li:'\n• ',p:'\n',label:'\n[LABEL] ' };
      function walk(n) {
        if (n.nodeType === 3) { const t = n.textContent.trim(); return t ? t + ' ' : ''; }
        if (n.nodeType !== 1) return '';
        const tag = n.tagName?.toLowerCase();
        if (!tag || SKIP.has(tag)) return '';
        if (tag === 'input')    return `\n[INPUT placeholder="${n.placeholder||''}" value="${n.value||''}"] `;
        if (tag === 'textarea') return `\n[TEXTAREA] ${n.value||''} `;
        if (n.isContentEditable) return `\n[EDITABLE id="${n.id||''}"] ${(n.textContent||'').slice(0,200)} `;
        return (PRE[tag] || '') + Array.from(n.childNodes).map(walk).join('');
      }
      return walk(document.body || document.documentElement)
        .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
    });
  } catch (_) {
    return page.evaluate(() => document.body?.innerText?.slice(0, 6000) || '').catch(() => '');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function getUserDataDir() {
  const home = os.homedir();
  const p    = process.platform;
  const candidates = p === 'win32' ? [
    path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    path.join(home, 'AppData', 'Local', 'Chromium', 'User Data'),
  ] : p === 'darwin' ? [
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
  ] : [
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'chromium'),
  ];
  return candidates.find(d => { try { return fs.existsSync(d); } catch (_) { return false; } }) || null;
}

async function cleanup(ctx) {
  ctx.browser = null; ctx.page = null; ctx.tabs = [];
}

function rv(t, vars) {
  return String(t || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function fmtParams(p) {
  if (!p || !Object.keys(p).length) return '';
  return Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(String(v || '').slice(0, 40))}`).join(' ');
}

function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }

module.exports = { runTask, stopTask, setGeminiKey };
