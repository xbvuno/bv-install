const { runPowerShell } = require('./powershell');

/**
 * Checks if the current terminal is running with Administrator privileges.
 * 
 * @returns {Promise<boolean>}
 */
async function checkIsAdmin() {
  try {
    const result = await runPowerShell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    return result.toLowerCase() === 'true';
  } catch (e) {
    return false;
  }
}

/**
 * Registers the uninstaller inside the Windows registry.
 * 
 * @param {object} options
 * @param {string} options.appName The name of the application.
 * @param {string} options.displayName The human-friendly name of the application.
 * @param {string} options.installLocation The folder where the app is installed.
 * @param {string} options.mainExePath Absolute path to the main executable.
 * @param {string} options.version The version of the application.
 * @param {string} options.publisher The publisher/company name.
 * @param {string} options.startMenuShortcutPath Absolute path to the Start Menu shortcut.
 * @param {string} options.desktopShortcutPath Absolute path to the Desktop shortcut (if created).
 * @param {boolean} options.isSystemWide Whether this is a system-wide installation.
 * @returns {Promise<void>}
 */
async function registerUninstallEntry({
  appName,
  displayName,
  installLocation,
  mainExePath,
  version = '1.0.0',
  publisher = 'Portable App',
  startMenuShortcutPath,
  desktopShortcutPath,
  isSystemWide = false,
  addedToPathDir = null
}) {
  const hive = isSystemWide ? 'HKLM' : 'HKCU';
  const regPath = `${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appName}`;
  
  // Format current date as YYYYMMDD
  const installDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const target = isSystemWide ? 'Machine' : 'User';
  const pathCleanupCommand = addedToPathDir ? 
    `\`$pVal = [Environment]::GetEnvironmentVariable('Path', '${target}'); \`$pList = \`$pVal -split ';' | Where-Object { \`$_.Trim() -ne '${addedToPathDir.replace(/'/g, "''")}' }; [Environment]::SetEnvironmentVariable('Path', (\`$pList -join ';'), '${target}')`
    : '';

  // Craft a robust uninstallation command in PowerShell
  // This command will delete the registry key, shortcuts, remove PATH entry, and delete the entire folder.
  const uninstallCommandList = [
    `Remove-Item -Path '${regPath}' -Force -ErrorAction SilentlyContinue`,
    startMenuShortcutPath ? `Remove-Item -Path '${startMenuShortcutPath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue` : '',
    desktopShortcutPath ? `Remove-Item -Path '${desktopShortcutPath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue` : '',
    pathCleanupCommand,
    `Remove-Item -Recurse -Force '${installLocation.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`
  ].filter(Boolean).join('; ');

  const uninstallString = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${uninstallCommandList}"`;

  const psScript = `
    $Path = "${regPath.replace(/"/g, '`"')}"
    if (!(Test-Path $Path)) {
        New-Item -Path $Path -Force | Out-Null
    }
    
    New-ItemProperty -Path $Path -Name "DisplayName" -Value "${displayName.replace(/"/g, '`"')}" -PropertyType "String" -Force | Out-Null
    New-ItemProperty -Path $Path -Name "DisplayIcon" -Value "${mainExePath.replace(/"/g, '`"')}" -PropertyType "String" -Force | Out-Null
    New-ItemProperty -Path $Path -Name "DisplayVersion" -Value "${version.replace(/"/g, '`"')}" -PropertyType "String" -Force | Out-Null
    New-ItemProperty -Path $Path -Name "Publisher" -Value "${publisher.replace(/"/g, '`"')}" -PropertyType "String" -Force | Out-Null
    New-ItemProperty -Path $Path -Name "InstallDate" -Value "${installDate}" -PropertyType "String" -Force | Out-Null
    New-ItemProperty -Path $Path -Name "InstallLocation" -Value "${installLocation.replace(/"/g, '`"')}" -PropertyType "String" -Force | Out-Null
    New-ItemProperty -Path $Path -Name "UninstallString" -Value "${uninstallString.replace(/"/g, '`"')}" -PropertyType "String" -Force | Out-Null
  `;

  await runPowerShell(psScript);
}

module.exports = {
  checkIsAdmin,
  registerUninstallEntry
};
