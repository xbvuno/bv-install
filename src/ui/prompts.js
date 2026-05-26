const { intro, outro, spinner, log, text, select, confirm, isCancel } = require('@clack/prompts');
const picocolors = require('picocolors');
const path = require('path');
const fs = require('fs').promises;
const { detectExecutables } = require('../core/detector');
const { extractZipToTemp, extractExeMetadata, resolveDestinationPath, installFolder, detectProgramRoot, addToPath } = require('../core/installer');
const { createShortcut, resolveShortcutPaths } = require('../core/shortcut');
const { checkIsAdmin, registerUninstallEntry } = require('../core/registry');


/**
 * Runs a task with an inline spinner that clears itself completely upon completion.
 * 
 * @param {string} message Lowercase message to display.
 * @param {function} taskFunc The async function to execute.
 * @returns {Promise<any>}
 */
async function runTaskWithSpinner(message, taskFunc) {
  const s = spinner();
  s.start(message);
  try {
    const result = await taskFunc();
    s.stop(message);
    return result;
  } catch (err) {
    s.stop(picocolors.red(`failed: ${message}`));
    throw err;
  }
}

/**
 * Runs an installation step with a live spinner, finishing with a clean, static, action-oriented log.
 * 
 * @param {string} message Action description.
 * @param {function} stepFunc Async function performing the work.
 */
async function runInstallStep(message, stepFunc) {
  const s = spinner();
  s.start(message);
  try {
    await stepFunc();
    s.stop(message);
  } catch (err) {
    s.stop(picocolors.red(`failed: ${message}`));
    throw err;
  }
}

/**
 * Interactive wizard following the custom Devtool aesthetics.
 * 
 * @param {string} targetFolder Source portable application folder path.
 */
async function runInstallerWizard(targetFolder) {
  let tempDirToClean = null;

  try {
    const absoluteSourceOriginal = path.resolve(targetFolder);
    let absoluteSource = absoluteSourceOriginal;

    // 1. Stylized lowercase intro
    intro(picocolors.bgCyan(picocolors.black(' bv-install ')));

    // Privilege warning in low-noise lowercase
    const isAdmin = await checkIsAdmin();
    if (isAdmin) {
      log.info(picocolors.yellow('running as admin • system-wide installation enabled'));
    } else {
      log.info(picocolors.dim('running as user • local installation only'));
    }

    // Check if zip and extract
    const stats = await fs.stat(absoluteSourceOriginal);
    const isZip = stats.isFile() && absoluteSourceOriginal.toLowerCase().endsWith('.zip');
    
    if (isZip) {
      const zipResult = await runTaskWithSpinner('extracting archive...', () => extractZipToTemp(absoluteSourceOriginal));
      tempDirToClean = zipResult.tempDir;
      absoluteSource = zipResult.activeSource;
    }

    const folderName = path.basename(absoluteSource);

    // 2. Scan directory for EXEs with temporary spinner
    let candidates, recommended;
    try {
      const scanResult = await runTaskWithSpinner('scanning folder...', () => detectExecutables(absoluteSource));
      candidates = scanResult.candidates;
      recommended = scanResult.recommended;
    } catch (error) {
      outro(picocolors.red('error scanning folder: ' + error.message));
      return;
    }

    if (candidates.length === 0) {
      outro(picocolors.red('no executables found in target folder'));
      return;
    }

    // 3. Main EXE Selection / Autodetect
    let selectedExe;
    if (candidates.length === 1) {
      const c = candidates[0];
      selectedExe = c.name;
      const sizeMB = (c.size / (1024 * 1024)).toFixed(1);
      const typeStr = c.isCli ? 'cli' : 'gui';
      log.info(`main exe: ${picocolors.bold(selectedExe)} (${sizeMB} MB) ${picocolors.dim(`[${typeStr}]`)}  [auto-selected]`);
    } else {
      // Show lowercase selection menu
      const options = candidates.map(c => {
        const isRec = c.name === recommended;
        const sizeMB = (c.size / (1024 * 1024)).toFixed(1);
        const typeStr = c.isCli ? 'cli' : 'gui';
        return {
          value: c.name,
          label: `${c.name} (${sizeMB} MB) ${picocolors.dim(`[${typeStr}]`)} ${isRec ? picocolors.green('[recommended]') : ''}`
        };
      });

      selectedExe = await select({
        message: 'select main exe:',
        options,
        initialValue: recommended
      });

      if (isCancel(selectedExe)) {
        outro('cancelled');
        return;
      }
    }

    // 3.5. Find isCli of the chosen candidate
    const candidateObj = candidates.find(c => c.name === selectedExe);
    const isCli = candidateObj ? candidateObj.isCli : false;

    // 3.6. Smart program root detection and shifting
    const rootDetection = detectProgramRoot(absoluteSource, selectedExe);
    const originalRoot = absoluteSource;
    absoluteSource = rootDetection.realSourceDir;
    selectedExe = rootDetection.newRelativeExePath;

    if (absoluteSource !== originalRoot) {
      log.info(`detected app root: ${picocolors.bold(path.basename(absoluteSource))}  [shifted to actual program root]`);
    }

    const selectedExePath = path.join(absoluteSource, selectedExe);

    // 4. Metadata extraction with temporary spinner
    const metadata = await runTaskWithSpinner('extracting metadata...', () => extractExeMetadata(selectedExePath));

    // Determine standard app name and display
    const defaultAppName = path.basename(selectedExe, '.exe');
    let appName = defaultAppName;
    let version = metadata.version;
    let publisher = metadata.publisher;

    log.info(`app: ${picocolors.bold(appName)} v${version}`);

    // 5. Destination path
    const safeFolderName = appName.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
    const isSystemWide = isAdmin;
    const destDir = resolveDestinationPath(safeFolderName, isSystemWide);

    log.info(`install to: ${picocolors.bold(destDir)}`);

    // 5.5. PATH integration prompt for CLI apps
    let shouldAddToPath = false;
    let shouldCreateStartMenuShortcut = true;
    if (isCli) {
      log.info('cli utility detected (runs in terminal)');
      
      const pathConfirm = await confirm({
        message: 'add to environment path?',
        initialValue: true
      });
      
      if (isCancel(pathConfirm)) {
        outro('cancelled');
        return;
      }
      
      shouldAddToPath = pathConfirm;

      const shortcutConfirm = await confirm({
        message: 'create start menu shortcut?',
        initialValue: false
      });

      if (isCancel(shortcutConfirm)) {
        outro('cancelled');
        return;
      }

      shouldCreateStartMenuShortcut = shortcutConfirm;
    }

    // 7. Installation with live action-oriented log spinners
    log.info('installing...');
    
    const shortcutPaths = await resolveShortcutPaths(appName, isSystemWide);
    const installedExePath = path.join(destDir, selectedExe);
    const addedPathDir = path.dirname(installedExePath);

    try {
      // Step A: Copy Files
      await runInstallStep('copying files', () => installFolder(absoluteSource, destDir));

      // Step A2: Add to PATH if requested
      if (shouldAddToPath) {
        await runInstallStep('adding to environment path', () => addToPath(addedPathDir, isSystemWide));
      }

      // Step B: Create Start Menu Shortcut
      if (shouldCreateStartMenuShortcut) {
        await runInstallStep('creating start menu shortcut', async () => {
          await createShortcut({
            shortcutPath: shortcutPaths.startMenu,
            targetPath: installedExePath,
            description: `shortcut for ${appName}`
          });
        });
      }

      // Step C: Registry Uninstaller setup
      await runInstallStep('registering uninstall entry', async () => {
        await registerUninstallEntry({
          appName: safeFolderName,
          displayName: appName,
          installLocation: destDir,
          mainExePath: installedExePath,
          version,
          publisher,
          startMenuShortcutPath: shouldCreateStartMenuShortcut ? shortcutPaths.startMenu : '',
          desktopShortcutPath: shortcutPaths.desktop,
          isSystemWide,
          addedToPathDir: shouldAddToPath ? addedPathDir : null
        });
      });

      // 8. Desktop Shortcut Confirm Prompt (AFTER installation)
      const createDesktopLnk = await confirm({
        message: 'create desktop shortcut?',
        initialValue: false
      });

      if (isCancel(createDesktopLnk)) {
        outro('cancelled');
        return;
      }
      
      if (createDesktopLnk) {
        await runInstallStep('creating desktop shortcut', async () => {
          await createShortcut({
            shortcutPath: shortcutPaths.desktop,
            targetPath: installedExePath,
            description: `shortcut for ${appName}`
          });
        });
      }

      // Outro SUCCESS
      log.success(`installed ${appName}`);
      if (shouldCreateStartMenuShortcut) {
        log.success('available in start menu');
      }
      if (createDesktopLnk) {
        log.success('available on desktop');
      }
      if (shouldAddToPath) {
        log.success('available in environment path');
      }
      log.success('available in installed apps');
      
      // Terminate using native clack outro!
      outro(picocolors.green('done!'));

    } catch (error) {
      outro(picocolors.red('error: ' + error.message));
    }
  } finally {
    if (tempDirToClean) {
      await fs.rm(tempDirToClean, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  runInstallerWizard
};
