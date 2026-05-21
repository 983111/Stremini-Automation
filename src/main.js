const {
  app, BrowserWindow, globalShortcut, Tray, Menu,
  ipcMain, screen, nativeImage, clipboard, desktopCapturer
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

let win     = null;
let tray    = null;
let visible = true;

const W = 590, H = 600;

// ── Gemini API Key ───────────────────────────────────────────────────────────
// Set GEMINI_API_KEY as an environment variable, or paste it directly here:
const GEMINI_API_KEY = ';

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
      sandbox: false,
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
ipcMain.handle('read-clipboard',  ()     => clipboard.readText() || '');
ipcMain.handle('write-clipboard', (_, t) => { clipboard.writeText(t); return true; });

// ── Desktop screenshot helper ────────────────────────────────────────────────
async function refreshDesktopScreenshot() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (sources.length > 0) {
      const tmpPath = path.join(os.tmpdir(), 'stremini_screen.png');
      fs.writeFileSync(tmpPath, sources[0].thumbnail.toPNG());
      return { path: tmpPath, name: sources[0].name };
    }
  } catch (_) {}
  return null;
}

// ── IPC: screen capture ──────────────────────────────────────────────────────
ipcMain.handle('capture-screen', async () => {
  try {
    if (win) win.hide();
    await sleep(300);

    const shot = await refreshDesktopScreenshot();

    let capturedText = '';
    let title = 'Desktop';
    let url   = '';

    const others = BrowserWindow.getAllWindows().filter(
      w => w !== win && !w.isDestroyed() && w.isVisible()
    );
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

    if (!capturedText && shot) {
      const clip = clipboard.readText();
      capturedText = clip ? `Clipboard:\n${clip.slice(0, 2000)}` : 'Screenshot captured.';
      title = shot.name || 'Desktop';
    }

    if (win) win.showInactive();
    if (shot) win && win.webContents.send('screen-captured', { imagePath: shot.path, title });

    return {
      text:      capturedText || 'No readable content.',
      title,
      url,
      imagePath: shot?.path || null,
      hasImage:  !!shot,
    };
  } catch (e) {
    if (win) win.showInactive();
    return { text: `Screen read error: ${e.message}`, title: '', url: '', hasImage: false };
  }
});

// ── IPC: automation ──────────────────────────────────────────────────────────
ipcMain.handle('run-automation', async (_, { task }) => {
  const engine = require(path.join(__dirname, 'automation', 'engine'));
  engine.setGeminiKey(GEMINI_API_KEY);
  await refreshDesktopScreenshot();

  return new Promise(resolve => {
    engine.runTask(
      task,
      step  => win && win.webContents.send('auto-step',  step),
      done  => { win && win.webContents.send('auto-done',  done);  resolve({ success: true,  done  }); },
      error => { win && win.webContents.send('auto-error', { message: error }); resolve({ success: false, error }); }
    );
  });
});

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
    { label: 'Stremini',               enabled: false },
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
