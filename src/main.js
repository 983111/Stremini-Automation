const {
  app, BrowserWindow, globalShortcut, Tray, Menu,
  ipcMain, screen, nativeImage, clipboard, desktopCapturer
} = require('electron');
const path = require('path');

let win  = null;
let tray = null;
let visible = true;

const W = 590, H = 600;

// ── Create overlay window ────────────────────────────────────────────────────
function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: W, height: H,
    x: sw - W - 16, y: sh - H - 16,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: true, hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.on('closed', () => { win = null; });
}

// ── Toggle show/hide ─────────────────────────────────────────────────────────
function toggle(force) {
  if (!win) return;
  visible = typeof force === 'boolean' ? force : !visible;
  if (visible) {
    win.showInactive();
    win.webContents.send('show');
  } else {
    win.webContents.send('hide-anim');
    setTimeout(() => win && win.hide(), 220);
  }
}

// ── IPC: resize ──────────────────────────────────────────────────────────────
ipcMain.on('resize', (_, { height }) => {
  if (!win) return;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const h = Math.min(Math.max(height, 120), H);
  win.setBounds({ x: sw - W - 16, y: sh - h - 16, width: W, height: h });
});

ipcMain.on('hide', () => toggle(false));

// ── IPC: clipboard ───────────────────────────────────────────────────────────
ipcMain.handle('read-clipboard',  ()    => clipboard.readText() || '');
ipcMain.handle('write-clipboard', (_, t) => { clipboard.writeText(t); return true; });

// ── IPC: screen capture → real screenshot + text extraction ─────────────────
ipcMain.handle('capture-screen', async () => {
  try {
    // Step 1: hide overlay briefly so it's not captured
    if (win) win.hide();
    await sleep(300);

    let capturedText = '';
    let title = 'Desktop';
    let url = '';

    // Step 2: Try reading text from other visible Electron windows first
    const others = BrowserWindow.getAllWindows().filter(w => w !== win && !w.isDestroyed() && w.isVisible());
    for (const w of others) {
      try {
        const text = await w.webContents.executeJavaScript(
          `document.body ? document.body.innerText.slice(0, 6000) : ''`, true
        );
        if (text && text.length > 40) {
          capturedText = `[${w.getTitle()}]\n\n${text}`;
          title = w.getTitle();
          url   = w.webContents.getURL();
          break;
        }
      } catch (_) {}
    }

    // Step 3: Use desktopCapturer to get a real screenshot, then extract text via JS
    if (!capturedText) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        });

        // Save the screenshot to a temp file so the AI can reference it
        if (sources.length > 0) {
          const img = sources[0].thumbnail;
          const tmpPath = path.join(require('os').tmpdir(), 'stremini_screen.png');
          require('fs').writeFileSync(tmpPath, img.toPNG());

          // Send the screenshot path to the renderer so it can be described by the AI
          if (win) {
            win.showInactive();
            win.webContents.send('screen-captured', { imagePath: tmpPath, title: sources[0].name });
          }

          // Also extract window names + clipboard as text fallback context
          const windowNames = sources
            .filter(s => s.name && s.name !== 'Stremini')
            .slice(0, 8)
            .map(s => `• ${s.name}`)
            .join('\n');
          const clip = clipboard.readText();
          capturedText = [
            windowNames ? `Visible windows:\n${windowNames}` : '',
            clip ? `Clipboard:\n${clip.slice(0, 2000)}` : '',
          ].filter(Boolean).join('\n\n') || 'Screen captured as image.';

          title = sources[0].name || 'Desktop';
          return { text: capturedText, title, url, imagePath: tmpPath, hasImage: true };
        }
      } catch (e) {
        capturedText = `Screen capture error: ${e.message}`;
      }
    }

    if (win) win.showInactive();
    return { text: capturedText || 'No readable screen content found.', title, url, hasImage: false };
  } catch (e) {
    if (win) win.showInactive();
    return { text: `Screen read error: ${e.message}`, title: '', url: '', hasImage: false };
  }
});

// ── IPC: automation ──────────────────────────────────────────────────────────
let _autoCtx = null;

ipcMain.handle('run-automation', async (_, { task }) => {
  const { runTask } = require(path.join(__dirname, 'automation', 'engine'));
  return new Promise(resolve => {
    runTask(
      task,
      step  => win && win.webContents.send('auto-step',  step),
      done  => { win && win.webContents.send('auto-done',  done);  resolve({ success: true,  done  }); },
      error => { win && win.webContents.send('auto-error', { message: error }); resolve({ success: false, error }); }
    );
  });
});

// ADD this new handler for the stop button:
ipcMain.handle('stop-automation', () => {
  const { stopTask } = require(path.join(__dirname, 'automation', 'engine'));
  stopTask();
  return true;
});

// ── IPC: security scan ───────────────────────────────────────────────────────
ipcMain.handle('security-scan', async (_, { content, scanType }) => {
  const { scanContent } = require(path.join(__dirname, 'automation', 'security'));
  return scanContent(content, scanType);
});

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  globalShortcut.register('CommandOrControl+Space', () => toggle());
  globalShortcut.register('CommandOrControl+`',     () => toggle());

  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Stremini — Ctrl+Space to toggle');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Stremini',              enabled: false },
    { type:  'separator' },
    { label: 'Show/Hide (Ctrl+Space)', click: () => toggle() },
    { type:  'separator' },
    { label: 'Quit',                   click: () => app.quit() },
  ]));
  tray.on('click', () => toggle());
});

app.on('will-quit',         () => globalShortcut.unregisterAll());
app.on('window-all-closed', e  => e.preventDefault());

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }