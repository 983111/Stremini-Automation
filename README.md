# Stremini Desktop
**Floating AI Overlay — Exact match to product screenshots**

## Quick Start

### Prerequisites
- Node.js 18+ → https://nodejs.org
- npm (comes with Node)

### Install & Run
```bash
npm install
npm start
```

### Build Windows .exe installer
```bash
npm install
npm run build
# → dist/Stremini Setup x.x.x.exe
```

### Build macOS .dmg
```bash
npm run build:mac
```

### Build Linux AppImage
```bash
npm run build:linux
```

---

## How It Works

| Hotkey | Action |
|--------|--------|
| `Ctrl + Space` | Toggle overlay show/hide |
| `Ctrl + \`` | Also toggles overlay |
| `Escape` | Close response panel |

**The overlay:**
- Floats bottom-right, always on top of every window
- Transparent / frameless — blends into any background
- Action bar: Summarize · Rewrite · Extract Tasks · Geneat Reply · Explain Code · Clipbard Tools
- Input bar: "Ask anything..." with send + mic buttons
- Response panel slides up above the bar on any action

**Smart auto-routing:**
- "Summarize this..." → overlay/summarise
- "Fix this bug..." → agent/code
- "Phishing email..." → security scan
- "When invoice arrives..." → automation engine
- "Write proposal for..." → write intelligence
- "ARIA, plan my day" → ARIA agent

---

## File Structure
```
stremini-desktop/
├── src/
│   ├── main.js       ← Electron main process (window, hotkeys, tray)
│   ├── preload.js    ← Secure IPC bridge
│   └── overlay.html  ← Full UI renderer
├── assets/
│   └── icon.png      ← App icon (add your own 256×256 PNG)
├── package.json
└── README.md
```

## Add App Icon
Place a 256×256 PNG at `assets/icon.png` before building.
For Windows `.ico`: place at `assets/icon.ico`.

---

## Worker Endpoint
Calls: `https://automation-agent.vishwajeetadkine705.workers.dev`

All modes supported: `overlay`, `automate`, `write`, `security`, `agent`, `chat`
