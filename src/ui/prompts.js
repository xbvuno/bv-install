const { intro, text, select, confirm } = require('@clack/prompts');
const picocolors = require('picocolors');
const path = require('path');
const fs = require('fs').promises;
const { detectExecutables } = require('../core/detector');
const { extractZipToTemp, extractExeMetadata, resolveDestinationPath, installFolder, detectProgramRoot, addToPath } = require('../core/installer');
const { createShortcut, resolveShortcutPaths } = require('../core/shortcut');
const { checkIsAdmin, registerUninstallEntry } = require('../core/registry');

/**
 * Helper to clear a specific number of lines in the terminal.
 * Used to remove temporary prompt outputs and maintain a custom, pristine flow layout.
 * 
 * @param {number} count Number of lines to clear upwards.
 */
function clearLines(count) {
  for (let i = 0; i < count; i++) {
    process.stdout.write('\x1B[1A\x1B[2K');
  }
}

/**
 * Runs a task with an inline spinner that clears itself completely upon completion.
 * 
 * @param {string} message Lowercase message to display.
 * @param {function} taskFunc The async function to execute.
 * @returns {Promise<any>}
 */
async function runTaskWithSpinner(message, taskFunc) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  
  // Draw initial spinner frame
  process.stdout.write(`${picocolors.cyan('│')}  ${picocolors.cyan(frames[0])}  ${message}\r`);
  
  const interval = setInterval(() => {
    process.stdout.write(`${picocolors.cyan('│')}  ${picocolors.cyan(frames[i])}  ${message}\r`);
    i = (i + 1) % frames.length;
  }, 80);
  
  try {
    const result = await taskFunc();
    clearInterval(interval);
    // Completely clear the line so it leaves no trace
    process.stdout.write('\r\x1B[2K');
    return result;
  } catch (err) {
    clearInterval(interval);
    process.stdout.write('\r\x1B[2K');
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
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  
  process.stdout.write(`${picocolors.cyan('│')}  ${picocolors.cyan(frames[0])}  ${message}\r`);
  
  const interval = setInterval(() => {
    process.stdout.write(`${picocolors.cyan('│')}  ${picocolors.cyan(frames[i])}  ${message}\r`);
    i = (i + 1) % frames.length;
  }, 80);
  
  try {
    await stepFunc();
    clearInterval(interval);
    // Overwrite the spinner line with a static, action-oriented line as requested, clearing the line first
    process.stdout.write(`\r\x1B[2K${picocolors.cyan('│')}  ${message}\n`);
  } catch (err) {
    clearInterval(interval);
    process.stdout.write(`\r\x1B[2K${picocolors.cyan('│')}  ${picocolors.red('failed: ' + message)}\n`);
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
    intro(picocolors.cyan('bv-install'));

    // Privilege warning in low-noise lowercase
    const isAdmin = await checkIsAdmin();
    if (isAdmin) {
      console.log(`${picocolors.cyan('│')}  ${picocolors.yellow('running as admin • system-wide installation enabled')}`);
    } else {
      console.log(`${picocolors.cyan('│')}  ${picocolors.dim('running as user • local installation only')}`);
    }
    console.log(`${picocolors.cyan('│')}`);

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
      console.log(`${picocolors.cyan('└')}  ${picocolors.red('error scanning folder: ' + error.message)}\n`);
      return;
    }

    if (candidates.length === 0) {
      console.log(`${picocolors.cyan('└')}  ${picocolors.red('no executables found in target folder')}\n`);
      return;
    }

    // 3. Main EXE Selection / Autodetect
    let selectedExe;
    if (candidates.length === 1) {
      const c = candidates[0];
      selectedExe = c.name;
      const sizeMB = (c.size / (1024 * 1024)).toFixed(1);
      const typeStr = c.isCli ? 'cli' : 'gui';
      console.log(`${picocolors.cyan('◆')}  main exe`);
      console.log(`${picocolors.cyan('│')}  ${picocolors.bold(selectedExe)} (${sizeMB} MB) ${picocolors.dim(`[${typeStr}]`)}  [auto-selected]`);
      console.log(`${picocolors.cyan('│')}`);
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

      if (typeof selectedExe === 'symbol') {
        console.log(`${picocolors.cyan('└')}  cancelled\n`);
        return;
      }
      
      // Clear the clack select prompt printout
      clearLines(2);
      const chosenCandidate = candidates.find(c => c.name === selectedExe);
      const chosenSizeMB = chosenCandidate ? (chosenCandidate.size / (1024 * 1024)).toFixed(1) : '0.0';
      const chosenTypeStr = chosenCandidate && chosenCandidate.isCli ? 'cli' : 'gui';
      console.log(`${picocolors.cyan('◆')}  main exe`);
      console.log(`${picocolors.cyan('│')}  ${picocolors.bold(selectedExe)} (${chosenSizeMB} MB) ${picocolors.dim(`[${chosenTypeStr}]`)}`);
      console.log(`${picocolors.cyan('│')}`);
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
      console.log(`${picocolors.cyan('◆')}  detected app root`);
      console.log(`${picocolors.cyan('│')}  ${picocolors.bold(path.basename(absoluteSource))}  [shifted to actual program root]`);
      console.log(`${picocolors.cyan('│')}`);
    }

    const selectedExePath = path.join(absoluteSource, selectedExe);

    // 4. Metadata extraction with temporary spinner
    const metadata = await runTaskWithSpinner('extracting metadata...', () => extractExeMetadata(selectedExePath));

    // Determine standard app name and display
    const defaultAppName = path.basename(selectedExe, '.exe');
    
    // Customization step (optional but standard)
    let appName = defaultAppName;
    let version = metadata.version;
    let publisher = metadata.publisher;

    console.log(`${picocolors.cyan('◆')}  app`);
    console.log(`${picocolors.cyan('│')}  ${picocolors.bold(appName)} v${version}`);
    console.log(`${picocolors.cyan('│')}`);

    // 5. Destination path
    const safeFolderName = appName.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
    const isSystemWide = isAdmin;
    const destDir = resolveDestinationPath(safeFolderName, isSystemWide);

    console.log(`${picocolors.cyan('◆')}  install to`);
    console.log(`${picocolors.cyan('│')}  ${picocolors.bold(destDir)}`);
    console.log(`${picocolors.cyan('│')}`);

    // 5.5. PATH integration prompt for CLI apps
    let shouldAddToPath = false;
    let shouldCreateStartMenuShortcut = true;
    if (isCli) {
      console.log(`${picocolors.cyan('◆')}  cli utility detected`);
      console.log(`${picocolors.cyan('│')}  this app runs in the console`);
      console.log(`${picocolors.cyan('│')}`);
      
      const pathConfirm = await confirm({
        message: 'add to environment path?',
        initialValue: true
      });
      
      if (typeof pathConfirm === 'symbol') {
        console.log(`${picocolors.cyan('└')}  cancelled\n`);
        return;
      }
      
      shouldAddToPath = pathConfirm;
      
      clearLines(2);
      console.log(`${picocolors.cyan('◇')}  add to environment path?`);
      console.log(`${picocolors.cyan('│')}  ${shouldAddToPath ? 'yes' : 'no'}`);
      console.log(`${picocolors.cyan('│')}`);

      const shortcutConfirm = await confirm({
        message: 'create start menu shortcut?',
        initialValue: false
      });

      if (typeof shortcutConfirm === 'symbol') {
        console.log(`${picocolors.cyan('└')}  cancelled\n`);
        return;
      }

      shouldCreateStartMenuShortcut = shortcutConfirm;

      clearLines(2);
      console.log(`${picocolors.cyan('◇')}  create start menu shortcut?`);
      console.log(`${picocolors.cyan('│')}  ${shouldCreateStartMenuShortcut ? 'yes' : 'no'}`);
      console.log(`${picocolors.cyan('│')}`);
    }

    // 6. Proceed Continue Prompt
    const proceed = await confirm({
      message: 'continue?',
      initialValue: true
    });

  if (typeof proceed === 'symbol' || !proceed) {
    console.log(`${picocolors.cyan('└')}  cancelled\n`);
    return;
  }

  clearLines(2);
  console.log(`${picocolors.cyan('◇')}  continue?`);
  console.log(`${picocolors.cyan('│')}  yes`);
  console.log(`${picocolors.cyan('│')}`);

  // 7. Installation with live action-oriented log spinners
  console.log(`${picocolors.cyan('◆')}  installing...`);
  
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
    // Note: We always pass both shortcut paths to the registry uninstaller so it is ready
    // to clean up either/both if they exist.
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

    // Trailing blank separator line
    console.log(`${picocolors.cyan('│')}`);

    // 8. Desktop Shortcut Confirm Prompt (AFTER installation)
    const createDesktopLnk = await confirm({
      message: 'create desktop shortcut?',
      initialValue: false
    });

    if (typeof createDesktopLnk === 'symbol') {
      console.log(`${picocolors.cyan('└')}  cancelled\n`);
      return;
    }
    
    clearLines(2);
    console.log(`${picocolors.cyan('◇')}  create desktop shortcut?`);
    console.log(`${picocolors.cyan('│')}  ${createDesktopLnk ? 'yes' : 'no'}`);
    
    if (createDesktopLnk) {
      await runInstallStep('creating desktop shortcut', async () => {
        await createShortcut({
          shortcutPath: shortcutPaths.desktop,
          targetPath: installedExePath,
          description: `shortcut for ${appName}`
        });
      });
    }

    // Trailing blank separator line
    console.log(`${picocolors.cyan('│')}`);

    // Outro SUCCESS
    console.log(`${picocolors.cyan('└')}  installed ${appName}\n`);
    console.log(`   available in start menu`);
    console.log(`   available in installed apps\n`);

  } catch (error) {
    console.log(`${picocolors.cyan('│')}  ${picocolors.red('failed')}`);
    console.log(`${picocolors.cyan('└')}  ${picocolors.red('error: ' + error.message)}\n`);
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
