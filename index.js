const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

let mainWindow;
let currentRepository = null;
let patchesDirectory = path.join(app.getPath('userData'), 'saved_patches');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  await fs.mkdir(patchesDirectory, { recursive: true });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function runGitCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: currentRepository }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

ipcMain.handle('open-repository', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (!result.canceled) {
    currentRepository = result.filePaths[0];
    try {
      await runGitCommand('git rev-parse --is-inside-work-tree');
      return { success: true, path: currentRepository };
    } catch (error) {
      currentRepository = null;
      return { success: false, error: 'The selected folder is not a Git repository.' };
    }
  }
  return { success: false, error: 'No folder selected.' };
});

ipcMain.handle('get-stashes', async () => {
  if (!currentRepository) {
    throw new Error('No repository selected');
  }
  const output = await runGitCommand('git stash list');
  return output.split('\n').filter(Boolean).map(stash => {
    const [index, description] = stash.split(': ');
    return { index, description };
  });
});

ipcMain.handle('apply-stash', async (event, index) => {
  if (!currentRepository) {
    throw new Error('No repository selected');
  }
  return runGitCommand(`git stash apply ${index}`);
});

ipcMain.handle('get-stash-content', async (event, stashIndex) => {
  if (!currentRepository) {
    throw new Error('No repository selected');
  }
  const output = await runGitCommand(`git stash show -p ${stashIndex}`);
  return output; // Return the raw diff output
});

ipcMain.handle('export-stash-patch', async (event, stashIndex, stashDescription) => {
  if (!currentRepository) {
    throw new Error('No repository selected');
  }
  
  const patchContent = await runGitCommand(`git stash show -p ${stashIndex}`);
  
  const sanitizedDescription = stashDescription.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const fileName = `stash-${stashIndex}-${sanitizedDescription}.patch`;
  const filePath = path.join(patchesDirectory, fileName);

  try {
    await fs.writeFile(filePath, patchContent);
    // Save metadata about the patch
    const metadata = {
      stashIndex,
      description: stashDescription,
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(`${filePath}.meta`, JSON.stringify(metadata));
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: 'Failed to save the patch file.' };
  }
});

ipcMain.handle('get-saved-patches', async () => {
  try {
    const files = await fs.readdir(patchesDirectory);
    const patchFiles = files.filter(file => file.endsWith('.patch'));
    const patchesInfo = await Promise.all(patchFiles.map(async (file) => {
      try {
        const metaContent = await fs.readFile(path.join(patchesDirectory, `${file}.meta`), 'utf-8');
        const metadata = JSON.parse(metaContent);
        return {
          fileName: file,
          ...metadata
        };
      } catch (error) {
        console.error(`Error reading metadata for ${file}:`, error);
        return {
          fileName: file,
          description: 'Unknown',
          stashIndex: 'Unknown',
          createdAt: 'Unknown'
        };
      }
    }));
    return patchesInfo;
  } catch (error) {
    console.error('Error reading patches directory:', error);
    return [];
  }
});

ipcMain.handle('read-patch-file', async (event, fileName) => {
  try {
    const filePath = path.join(patchesDirectory, fileName);
    const content = await fs.readFile(filePath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    console.error('Error reading patch file:', error);
    return { success: false, error: 'Failed to read the patch file.' };
  }
});