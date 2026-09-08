const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 3210;
const appIcon = path.join(__dirname, 'build', 'azha-icon.png');
const updateConfigPath = path.join(__dirname, 'desktop-update-config.json');
let serverProcess;

function compareVersions(left, right) {
    const a = String(left || '0').replace(/^v/i, '').split('.').map(Number);
    const b = String(right || '0').replace(/^v/i, '').split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
    }
    return 0;
}

function getUpdateManifestUrl() {
    try {
        const config = require(updateConfigPath);
        return String(config.manifestUrl || '').trim();
    } catch (error) {
        return '';
    }
}

async function getUpdateInfo() {
    const manifestUrl = getUpdateManifestUrl();
    if (!manifestUrl || manifestUrl.includes('YOUR-VERCEL-DOMAIN')) {
        return { ok: false, message: 'Cloud updates are not configured yet.' };
    }
    try {
        const response = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Update server returned ${response.status}.`);
        const manifest = await response.json();
        const currentVersion = app.getVersion();
        const updateAvailable = compareVersions(manifest.version, currentVersion) > 0;
        return {
            ok: true,
            currentVersion,
            version: String(manifest.version || currentVersion),
            updateAvailable,
            downloadUrl: String(manifest.downloadUrl || '').trim()
        };
    } catch (error) {
        return { ok: false, message: 'The cloud update service could not be reached.' };
    }
}

ipcMain.handle('check-for-updates', getUpdateInfo);

ipcMain.handle('download-update', async (_event, url) => {
    const updateUrl = String(url || '').trim();
    if (!/^https:\/\//i.test(updateUrl)) return { ok: false };
    if (process.platform !== 'win32') {
        await shell.openExternal(updateUrl);
        return { ok: true };
    }

    const installerPath = path.join(os.tmpdir(), `azha-moh-update-${Date.now()}.exe`);
    try {
        const response = await fetch(updateUrl);
        if (!response.ok) throw new Error(`Installer download returned ${response.status}.`);
        await fs.promises.writeFile(installerPath, Buffer.from(await response.arrayBuffer()));
        spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => app.quit(), 500);
        return { ok: true, installing: true };
    } catch (error) {
        await fs.promises.rm(installerPath, { force: true }).catch(() => {});
        return { ok: false, message: 'The update installer could not be downloaded.' };
    }
});

async function checkForUpdatesOnStartup() {
    if (!app.isPackaged) return;
    const result = await getUpdateInfo();
    if (!result.ok || !result.updateAvailable || !result.downloadUrl) return;

    const choice = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Update now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'AZHA MOH update available',
        message: `AZHA MOH ${result.version} is ready to install.`,
        detail: 'The app will close, install the update, and then reopen automatically.'
    });
    if (choice.response !== 0) return;

    const updateResult = await new Promise((resolve) => {
        ipcMain.emit('download-update-internal', result.downloadUrl, resolve);
    });
    if (!updateResult.ok) {
        await dialog.showMessageBox({
            type: 'error',
            title: 'AZHA MOH update failed',
            message: updateResult.message || 'The update could not be installed.'
        });
    }
}

function waitForServer(url, attempts = 60) {
    return new Promise((resolve, reject) => {
        const check = (remaining) => {
            const request = http.get(url, (response) => {
                response.resume();
                resolve();
            });
            request.on('error', () => {
                if (remaining <= 0) {
                    reject(new Error('AZHA MOH server did not start.'));
                    return;
                }
                setTimeout(() => check(remaining - 1), 250);
            });
        };
        check(attempts);
    });
}

function startLocalServer() {
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = spawn(process.execPath, [serverPath], {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) },
        stdio: 'ignore'
    });
    serverProcess.on('error', (error) => console.error('AZHA server failed:', error));
}

function openBrowserWindow(url) {
    const browserWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: 'AZHA MOH Browser',
        icon: appIcon,
        backgroundColor: '#06131a',
        webPreferences: {
            contextIsolation: true,
            sandbox: true
        }
    });
    browserWindow.loadURL(url);
    browserWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        if (navigationUrl !== url) {
            event.preventDefault();
            openBrowserWindow(navigationUrl);
        }
    });
    browserWindow.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
        openBrowserWindow(openedUrl);
        return { action: 'deny' };
    });
    return browserWindow;
}

async function createMainWindow() {
    await waitForServer(`http://127.0.0.1:${PORT}/index.html`);
    const mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        title: 'AZHA MOH',
        icon: appIcon,
        backgroundColor: '#06131a',
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'desktop-preload.js')
        }
    });
    mainWindow.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        if (navigationUrl.startsWith(`http://127.0.0.1:${PORT}/`)) return;
        event.preventDefault();
        openBrowserWindow(navigationUrl);
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openBrowserWindow(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(async () => {
    startLocalServer();
    await createMainWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
}).catch((error) => {
    console.error(error);
    app.quit();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
});