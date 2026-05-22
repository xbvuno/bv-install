const { runPowerShell } = require('./powershell');
const path = require('path');

/**
 * Creates a Windows shortcut (.lnk file) using PowerShell.
 * 
 * @param {object} options
 * @param {string} options.shortcutPath Absolute path of the shortcut file to create.
 * @param {string} options.targetPath Absolute path of the executable.
 * @param {string} [options.workingDirectory] Working directory for the application (defaults to executable's directory).
 * @param {string} [options.description] Description of the shortcut.
 * @returns {Promise<void>}
 */
async function createShortcut({ shortcutPath, targetPath, workingDirectory, description = '' }) {
  const resolvedShortcutPath = path.resolve(shortcutPath);
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedWorkDir = workingDirectory ? path.resolve(workingDirectory) : path.dirname(resolvedTargetPath);

  const psScript = `
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("${resolvedShortcutPath.replace(/"/g, '`"')}")
    $Shortcut.TargetPath = "${resolvedTargetPath.replace(/"/g, '`"')}"
    $Shortcut.WorkingDirectory = "${resolvedWorkDir.replace(/"/g, '`"')}"
    $Shortcut.Description = "${description.replace(/"/g, '`"')}"
    $Shortcut.IconLocation = "${resolvedTargetPath.replace(/"/g, '`"')},0"
    $Shortcut.Save()
  `;

  await runPowerShell(psScript);
}

/**
 * Resolves standard Windows shortcut paths based on the installation type (user vs system).
 * 
 * @param {string} appName The name of the application.
 * @param {boolean} isSystemWide Whether the install is system-wide (requires admin).
 * @returns {Promise<{startMenu: string, desktop: string}>}
 */
async function resolveShortcutPaths(appName, isSystemWide) {
  // Query environment variables using PowerShell to ensure accuracy
  const psScript = isSystemWide 
    ? `echo "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs|$env:Public\\Desktop"`
    : `echo "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs|$env:USERPROFILE\\Desktop"`;
  
  const result = await runPowerShell(psScript);
  const [startMenuDir, desktopDir] = result.split('|').map(p => p.trim());
  
  return {
    startMenu: path.join(startMenuDir, `${appName}.lnk`),
    desktop: path.join(desktopDir, `${appName}.lnk`)
  };
}

module.exports = {
  createShortcut,
  resolveShortcutPaths
};
