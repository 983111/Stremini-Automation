/**
 * Stremini Agentic Engine v7
 * ─────────────────────────────────────────────────────────────────
 * Fixes v6 crash: worker ignores history[system], has no vision.
 *
 * Worker constraints (from index.js):
 *   • mode must be one of: overlay|automate|write|security|agent|chat
 *   • system prompt is ALWAYS rebuilt by worker from mode — cannot override it
 *   • history[] is appended as conversation turns AFTER worker's system prompt
 *   • NO vision / image support
 *   • Response shape: { status, mode, content } — content is plain text
 *
 * Solution:
 *   • ALL planner/observer calls use mode:"chat" — no system prompt injection
 *   • The full instruction is embedded IN the query string itself
 *   • Observer uses DOM text + page title instead of screenshots
 *   • JSON is parsed from the content field with fence stripping
 */

'use strict';
const { exec } = require('child_process');
const os       = require('os');
const path     = require('path');
const fs       = require('fs');

const WORKER    = 'https://automation-agent.vishwajeetadkine705.workers.dev';
const MAX_TURNS = 25;
const MAX_ACTS  = 6;

let _ctx = null;
function stopTask() { if (_ctx) _ctx.stopped = true; }

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
async function runTask(task, onStep, onDone, onError) {
  const ctx = { browser:null, page:null, tabs:[], vars:{}, log:[], goal:task, stopped:false };
  _ctx = ctx;

  try {
    onStep({ type:'planning', message:`🧠 Planning: "${task}"` });

    const initPlan = await llmPlan(task, '', ctx);
    if (!initPlan?.length) { onError('Planner returned an empty plan.'); return; }

    onStep({ type:'plan_ready', message:`📋 ${initPlan.length} actions`, plan:{ steps:initPlan } });

    let pending = [...initPlan];
    let turns   = 0;

    while (turns < MAX_TURNS && !ctx.stopped) {
      turns++;
      let actCount = 0, failedAt = null;

      // ── Execute batch ──────────────────────────────────────────────────────
      while (pending.length > 0 && actCount < MAX_ACTS && !ctx.stopped) {
        const action = pending.shift();
        actCount++;

        onStep({
          type:'executing', index:actCount, total:pending.length + actCount,
          message:`▶ [${actCount}] ${action.tool}(${fmtParams(action.params)})`,
          step:action,
        });

        try {
          const result = await executeAction(action, ctx, onStep);
          ctx.log.push(`✓ ${action.tool} → ${result?.output || 'ok'}`);
          if (result?.vars)   Object.assign(ctx.vars, result.vars);
          if (result?.output) onStep({ type:'step_output', message:result.output });
          if (result?.done)   { await cleanup(ctx); onDone({ message:result.done }); return; }
          await sleep(action.delay_ms ?? 1200);
        } catch (e) {
          ctx.log.push(`✗ ${action.tool}: ${e.message}`);
          onStep({ type:'step_error', message:`⚠ ${action.tool} failed: ${e.message}` });
          failedAt = { action, error:e.message };
          break;
        }
      }

      if (ctx.stopped) break;

      // ── Observe ────────────────────────────────────────────────────────────
      onStep({ type:'reading_screen', message:'👁 Observing page…' });
      const obs = await observe(ctx, failedAt);
      onStep({ type:'step_output', message:`👁 ${obs.summary}` });

      if (obs.done) { await cleanup(ctx); onDone({ message:`✅ ${obs.summary}` }); return; }

      if (obs.nextActions?.length) {
        pending = [...obs.nextActions, ...pending];
        onStep({ type:'plan_ready', message:`🔄 ${obs.nextActions.length} new actions`, plan:{ steps:obs.nextActions } });
      } else if (pending.length === 0) {
        await cleanup(ctx);
        onDone({ message:obs.summary || `✅ Done: ${task}` });
        return;
      }
    }

    await cleanup(ctx);
    if (ctx.stopped) onDone({ message:'⛔ Stopped by user.' });
    else             onDone({ message:`✅ Completed: ${task}` });

  } catch (e) {
    await cleanup(ctx);
    onError(`Agent error: ${e.message}`);
  } finally {
    _ctx = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Planner — embeds full instruction in query (worker chat mode)
// ─────────────────────────────────────────────────────────────────────────────
async function llmPlan(task, pageContext, ctx) {
  const logCtx = ctx.log.length ? `\nRECENT LOG:\n${ctx.log.slice(-6).join('\n')}` : '';
  const varCtx = Object.keys(ctx.vars).length
    ? `\nVARIABLES: ${Object.entries(ctx.vars).map(([k,v])=>`${k}="${String(v).slice(0,100)}"`).join(', ')}`
    : '';
  const pgCtx  = pageContext ? `\nCURRENT PAGE:\n${pageContext.slice(0, 2000)}` : '';

  const query = `You are an elite browser automation agent. Your ONLY job is to output a JSON array of actions.

TASK: ${task}${pgCtx}${logCtx}${varCtx}

TOOLS:
open_browser   — {}  — launch Playwright browser (ALWAYS first if no browser open)
goto_url       — { "url": "https://..." }
read_page      — {}  — read DOM text from current page (use after every navigation)
click          — { "selector": "CSS", "method": "css|text|placeholder" }
type_text      — { "selector": "CSS", "text": "...", "clear": true }
press_key      — { "key": "Enter|Tab|Escape|ctrl+a" }
scroll         — { "direction": "down|up", "amount": 3 }
wait           — { "ms": 2000 }
extract_text   — { "selector": "CSS", "var": "name" }
save_to_file   — { "filename": "out.txt", "content": "{varname}" }
done           — { "message": "what was completed" }

SELECTOR REFERENCE (use exactly):
ChatGPT input:     #prompt-textarea
Google search:     textarea[name='q']
YouTube search:    input#search
Gmail compose:     div[aria-label='Message Body']
Wikipedia search:  #searchInput

RULES:
1. ALWAYS open_browser first if no browser
2. ALWAYS goto_url then wait(2000) then read_page before any click/type
3. ChatGPT uses a contenteditable div — selector #prompt-textarea — type_text works on it
4. After typing in a chat box, press_key Enter to send
5. For sites needing login, add wait({"ms":12000}) after read_page so user can log in
6. End with done action
7. Output ONLY the raw JSON array — no explanation, no markdown fences

EXAMPLE for "search youtube for cats":
[
  {"tool":"open_browser","params":{}},
  {"tool":"goto_url","params":{"url":"https://youtube.com"}},
  {"tool":"wait","params":{"ms":2000}},
  {"tool":"read_page","params":{}},
  {"tool":"type_text","params":{"selector":"input#search","text":"cats","clear":true}},
  {"tool":"press_key","params":{"key":"Enter"}},
  {"tool":"done","params":{"message":"Searched YouTube for cats"}}
]

NOW output the JSON array for the task above:`;

  const content = await workerChat(query);
  return parseJSONArray(content, task);
}

// ─────────────────────────────────────────────────────────────────────────────
// Observer — uses DOM text, no vision (worker has no image support)
// ─────────────────────────────────────────────────────────────────────────────
async function observe(ctx, failedAt) {
  if (!ctx.page) return { done:false, summary:'No browser', nextActions:[] };

  const pageText = await getPageText(ctx.page);
  const url      = ctx.page.url();
  const title    = await ctx.page.title().catch(()=>'');
  const failCtx  = failedAt ? `\nLAST FAILURE: ${failedAt.action.tool} — ${failedAt.error}` : '';

  const query = `You are a browser automation observer. Analyse the current page and decide what to do next.

GOAL: ${ctx.goal}
CURRENT URL: ${url}
PAGE TITLE: ${title}
LOG:
${ctx.log.slice(-5).join('\n')}${failCtx}

PAGE CONTENT (first 2500 chars):
${pageText.slice(0, 2500)}

Respond ONLY with a raw JSON object (no markdown, no fences):
{
  "done": false,
  "summary": "what you see on the page right now",
  "nextActions": [
    {"tool":"type_text","params":{"selector":"#prompt-textarea","text":"hello"}},
    {"tool":"press_key","params":{"key":"Enter"}},
    {"tool":"done","params":{"message":"sent message"}}
  ]
}

If the goal is complete set done:true and nextActions:[].
Use the same tools: open_browser, goto_url, read_page, click, type_text, press_key, scroll, wait, extract_text, save_to_file, done.
Output ONLY the JSON object:`;

  try {
    const content = await workerChat(query);
    const clean   = content.replace(/^```[\w]*\n?/m,'').replace(/\n?```$/m,'').trim();
    const m       = clean.match(/\{[\s\S]*\}/);
    if (m) {
      const obs = JSON.parse(m[0]);
      return { done:!!obs.done, summary:obs.summary||title, nextActions:obs.nextActions||[] };
    }
  } catch(e) {
    // parse failed — log and continue
  }

  return { done:false, summary:`On: ${title || url}`, nextActions:[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker caller — always mode:chat, instruction embedded in query
// ─────────────────────────────────────────────────────────────────────────────
async function workerChat(query) {
  const res = await fetch(WORKER, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ mode:'chat', query }),
  });
  if (!res.ok) throw new Error(`Worker HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'ERROR') throw new Error(data.message || 'Worker error');
  return (data.content || data.solution || '').trim();
}

// Parse JSON array from LLM response, with fallback minimal plan
function parseJSONArray(content, task) {
  // Strip markdown fences
  let clean = content.replace(/^```[\w]*\n?/gm,'').replace(/\n?```/gm,'').trim();
  // Find first [ ... ]
  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start === -1 || end === -1) {
    // LLM returned prose — build a minimal safe plan
    console.error('Planner did not return JSON array. Response:', clean.slice(0,200));
    return buildFallbackPlan(task);
  }
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch(e) {
    console.error('JSON parse failed:', e.message, clean.slice(start, start+200));
    return buildFallbackPlan(task);
  }
}

function buildFallbackPlan(task) {
  // Detect common URL patterns in the task
  const urlMatch = task.match(/https?:\/\/\S+/);
  const url = urlMatch ? urlMatch[0] : 'https://google.com';
  return [
    { tool:'open_browser', params:{} },
    { tool:'goto_url',     params:{ url } },
    { tool:'wait',         params:{ ms:2000 } },
    { tool:'read_page',    params:{} },
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

  // open_browser — 3-strategy, never OS fallback
  async open_browser(_, ctx) {
    if (ctx.browser) return { output:'🌐 Browser already open' };
    const { chromium } = require('playwright');
    const args = ['--start-maximized','--no-sandbox','--disable-blink-features=AutomationControlled','--disable-infobars'];
    const anti = () => Object.defineProperty(navigator,'webdriver',{get:()=>false});
    const udd  = getUserDataDir();

    // Strategy 1: user Chrome profile — all sites stay logged in
    if (udd) {
      // Remove SingletonLock so Playwright can use your profile even if Chrome was recently closed
      try { const lk = path.join(udd, 'SingletonLock'); if (fs.existsSync(lk)) fs.unlinkSync(lk); } catch(_) {}
      try {
        const c = await chromium.launchPersistentContext(udd, { channel:'chrome', headless:false, slowMo:50, viewport:null, args, timeout:20000 });
        ctx.page    = c.pages()[0] || await c.newPage();
        ctx.browser = { context:c, close:async()=>{ try{await c.close();}catch(_){} } };
        ctx.tabs    = [ctx.page];
        await ctx.page.addInitScript(anti);
        return { output:'🌐 Chrome — profile loaded (all your logins active ✓)' };
      } catch(_) {}
    }
    // Strategy 2: Chrome channel, fresh session
    try {
      const b = await chromium.launch({ channel:'chrome', headless:false, slowMo:50, args });
      const p = await b.newPage();
      await p.addInitScript(anti); await p.setViewportSize({width:1280,height:800});
      ctx._browser=b; ctx.browser={context:null,close:async()=>{try{await b.close();}catch(_){}}};
      ctx.page=p; ctx.tabs=[p];
      return { output:'🌐 Chrome — fresh session' };
    } catch(_) {}
    // Strategy 3: bundled Chromium
    try {
      const b = await chromium.launch({ headless:false, slowMo:50, args });
      const p = await b.newPage();
      await p.addInitScript(anti); await p.setViewportSize({width:1280,height:800});
      ctx._browser=b; ctx.browser={context:null,close:async()=>{try{await b.close();}catch(_){}}};
      ctx.page=p; ctx.tabs=[p];
      return { output:'🌐 Chromium (bundled) — run: npx playwright install chromium' };
    } catch(e) {
      throw new Error('Cannot launch any browser. Run: npx playwright install chromium\n'+e.message);
    }
  },

  async goto_url({ url='https://google.com' }, ctx) {
    if (!ctx.page) throw new Error('No browser — add open_browser first');
    const u = url.startsWith('http') ? url : 'https://'+url;
    await ctx.page.goto(u, { waitUntil:'load', timeout:45000 })
      .catch(()=>ctx.page.goto(u, { waitUntil:'domcontentloaded', timeout:30000 }));
    await ctx.page.waitForLoadState('networkidle', {timeout:5000}).catch(()=>{});
    await sleep(1500);
    return { output:`🔗 ${u}` };
  },

  async read_page(_, ctx, onStep) {
    if (!ctx.page) return { output:'⚠ No page' };
    onStep({ type:'reading_screen', message:'👁 Reading page DOM…' });
    const text  = await getPageText(ctx.page);
    const url   = ctx.page.url();
    const title = await ctx.page.title().catch(()=>'');
    return { text, vars:{ page_text:text, page_url:url, page_title:title }, output:`👁 "${title}" (${text.length} chars)` };
  },

  async click({ selector, method='css', text:txt }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    const opts = { timeout:15000, force:true };
    let loc;
    if (method==='text'||txt)        loc = ctx.page.getByText(txt||selector,{exact:false}).first();
    else if (method==='placeholder') loc = ctx.page.getByPlaceholder(selector).first();
    else if (method==='role')        loc = ctx.page.getByRole('button',{name:selector}).or(ctx.page.getByRole('link',{name:selector})).first();
    else                             loc = ctx.page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded().catch(()=>{});
    await loc.click(opts).catch(async()=>{
      await ctx.page.evaluate(sel=>{
        const el=document.querySelector(sel); if(el)el.click(); else throw new Error('not found: '+sel);
      }, selector).catch(()=>{ throw new Error(`Click failed on: ${selector}`); });
    });
    await sleep(700);
    return { output:`🖱 Clicked: ${selector}` };
  },

  async type_text({ selector, text='', method='css', clear=true }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    text = rv(text, ctx.vars);
    let loc;
    if (method==='placeholder') loc = ctx.page.getByPlaceholder(selector).first();
    else if (method==='label')  loc = ctx.page.getByLabel(selector).first();
    else                        loc = ctx.page.locator(selector).first();

    await loc.waitFor({ state:'visible', timeout:15000 });
    await loc.scrollIntoViewIfNeeded().catch(()=>{});

    // Detect contenteditable — ChatGPT, Notion, Slack, etc.
    const isCE = await loc.evaluate(n =>
      n.isContentEditable || n.getAttribute('contenteditable')==='true'
    ).catch(()=>false);

    if (isCE) {
      await loc.click({ force:true });
      await sleep(200);
      if (clear) { await ctx.page.keyboard.press('Control+a'); await sleep(80); await ctx.page.keyboard.press('Delete'); await sleep(80); }
      await ctx.page.keyboard.type(text, { delay:28 });
    } else {
      if (clear) await loc.fill('').catch(()=>{});
      await loc.fill(text, { force:true, timeout:10000 })
        .catch(()=>loc.type(text, { delay:35 }));
    }
    return { output:`⌨ Typed: "${text.slice(0,60)}${text.length>60?'…':''}"` };
  },

  async press_key({ key }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    await ctx.page.keyboard.press(key);
    await sleep(500);
    return { output:`⌨ ${key}` };
  },

  async scroll({ direction='down', amount=3 }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    await ctx.page.mouse.wheel(0, direction==='down' ? amount*500 : -amount*500);
    await sleep(600);
    return { output:`📜 Scrolled ${direction}` };
  },

  async wait({ ms=2000 }) {
    await sleep(Math.min(ms,30000));
    return { output:`⏳ ${ms}ms` };
  },

  async extract_text({ selector, var:varName }, ctx) {
    if (!ctx.page) throw new Error('No browser');
    const text = await ctx.page.locator(selector).first().textContent({timeout:8000}).catch(()=>'');
    const res  = { output:`📄 "${String(text).slice(0,80)}"` };
    if (varName) res.vars = { [varName]:text?.trim()||'' };
    return res;
  },

  async save_to_file({ filename='stremini_output.txt', content }, ctx) {
    const text = rv(content||ctx.vars.page_text||'', ctx.vars);
    fs.writeFileSync(path.join(os.homedir(),'Desktop',filename), text, 'utf8');
    return { output:`💾 Saved to Desktop/${filename}` };
  },

  async done({ message='Done' }) {
    return { done:`✅ ${message}` };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM text extractor (non-destructive)
// ─────────────────────────────────────────────────────────────────────────────
async function getPageText(page) {
  try {
    return await page.evaluate(() => {
      const SKIP = new Set(['script','style','noscript','svg','head','iframe','canvas','meta','link']);
      const pre  = { h1:'\n# ',h2:'\n## ',h3:'\n### ',button:'\n[BTN] ',a:'\n[LINK] ',li:'\n• ',p:'\n',label:'\n[LABEL] ' };
      function walk(n) {
        if (n.nodeType===3) { const t=n.textContent.trim(); return t?t+' ':''; }
        if (n.nodeType!==1) return '';
        const tag=n.tagName?.toLowerCase();
        if (SKIP.has(tag)) return '';
        if (tag==='input')    return `\n[INPUT placeholder="${n.placeholder||''}" value="${n.value||''}"] `;
        if (tag==='select')   return `\n[SELECT] `;
        if (tag==='textarea') return `\n[TEXTAREA placeholder="${n.placeholder||''}"] ${n.value||''} `;
        if (n.isContentEditable) return `\n[EDITABLE id="${n.id||''}" class="${n.className?.slice?.(0,30)||''}"] ${n.textContent?.slice(0,200)||''} `;
        return (pre[tag]||'')+Array.from(n.childNodes).map(walk).join('');
      }
      return walk(document.body||document.documentElement).replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim().slice(0,6000);
    });
  } catch(_) {
    return page.evaluate(()=>document.body?.innerText?.slice(0,5000)||'').catch(()=>'');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function getUserDataDir() {
  const home=os.homedir(), p=process.platform;
  const candidates = p==='win32' ? [
    path.join(home,'AppData','Local','Google','Chrome','User Data'),
    path.join(home,'AppData','Local','Chromium','User Data'),
  ] : p==='darwin' ? [
    path.join(home,'Library','Application Support','Google','Chrome'),
  ] : [
    path.join(home,'.config','google-chrome'),
    path.join(home,'.config','chromium'),
  ];
  return candidates.find(d=>{ try{return fs.existsSync(d);}catch(_){return false;} })||null;
}

async function cleanup(ctx) {
  // Browser is intentionally left open after task completes so the user can see the result.
  // Only clear internal references — do NOT close the browser window.
  ctx.browser = null; ctx.page = null; ctx.tabs = [];
}

function rv(t, vars) {
  return String(t||'').replace(/\{(\w+)\}/g,(_,k)=>vars[k]??`{${k}}`);
}

function fmtParams(p) {
  if (!p||!Object.keys(p).length) return '';
  return Object.entries(p).map(([k,v])=>`${k}=${JSON.stringify(String(v||'').slice(0,35))}`).join(' ');
}

function sleep(ms) { return new Promise(r=>setTimeout(r,Math.max(0,ms))); }

module.exports = { runTask, stopTask };