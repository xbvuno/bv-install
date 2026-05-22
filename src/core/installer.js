const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { runPowerShell } = require('./powershell');

/**
 * Extracts a .zip archive to a temporary directory using PowerShell Expand-Archive.
 * Auto-unwraps single-folder root zip structures.
 * 
 * @param {string} zipPath Absolute path to the .zip archive.
 * @returns {Promise<{tempDir: string, activeSource: string}>}
 */
async function extractZipToTemp(zipPath) {
  const resolvedZip = path.resolve(zipPath);
  const tempBase = path.join(os.tmpdir(), 'bv-install-');
  const tempDir = await fs.mkdir(tempBase, { recursive: true }).then(() => fs.mkdtemp(tempBase));
  
  try {
    // Extract using Expand-Archive
    await runPowerShell(`Expand-Archive -Path "${resolvedZip.replace(/"/g, '`"')}" -DestinationPath "${tempDir.replace(/"/g, '`"')}" -Force`);
    
    // Auto-unwrap single root folder structure
    const files = await fs.readdir(tempDir, { withFileTypes: true });
    
    // Filter out metadata files like __MACOSX if present
    const visibleFiles = files.filter(f => f.name !== '__MACOSX' && !f.name.startsWith('.'));
    
    let activeSource = tempDir;
    if (visibleFiles.length === 1 && visibleFiles[0].isDirectory()) {
      activeSource = path.join(tempDir, visibleFiles[0].name);
    }
    
    return { tempDir, activeSource };
  } catch (error) {
    // Cleanup on error
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Extracts Windows-native file version info and publisher metadata from an executable.
 * 
 * @param {string} exePath Absolute path to the .exe file.
 * @returns {Promise<{version: string, publisher: string}>}
 */
async function extractExeMetadata(exePath) {
  try {
    const resolvedExePath = path.resolve(exePath);
    // Retrieve ProductVersion and CompanyName from File VersionInfo
    const result = await runPowerShell(`
      $info = (Get-Item "${resolvedExePath.replace(/"/g, '`"')}").VersionInfo
      echo "$($info.ProductVersion)|$($info.CompanyName)"
    `);
    
    let [version, publisher] = result.split('|').map(x => x.trim());
    
    // Clean up empty or null strings
    version = version && version !== 'null' ? version : '1.0.0';
    publisher = publisher && publisher !== 'null' ? publisher : 'Portable App';
    
    return { version, publisher };
  } catch (e) {
    return { version: '1.0.0', publisher: 'Portable App' };
  }
}

/**
 * Resolves the destination directory for the application based on the user privilege and app name.
 * 
 * @param {string} appName The sanitized name of the application.
 * @param {boolean} isSystemWide Whether to install system-wide (requires admin).
 * @returns {string} The resolved absolute installation path.
 */
function resolveDestinationPath(appName, isSystemWide) {
  if (isSystemWide) {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return path.join(programFiles, appName);
  } else {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData\\Local');
    return path.join(localAppData, 'Programs', appName);
  }
}

/**
 * Installs the portable folder into the destination directory by copying its contents.
 * 
 * @param {string} sourceDir The source portable folder path.
 * @param {string} destDir The target destination path.
 * @param {function} [onProgress] Optional callback for copy progress (for future extension).
 * @returns {Promise<void>}
 */
async function installFolder(sourceDir, destDir, onProgress) {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedDest = path.resolve(destDir);
  
  // Ensure the destination folder exists (fs.cp creates it, but we can make sure)
  await fs.mkdir(resolvedDest, { recursive: true });
  
  // Perform recursive copy using modern native Node fs.cp (supported on Node v16.7.0+)
  await fs.cp(resolvedSource, resolvedDest, {
    recursive: true,
    filter: (src, dest) => {
      // Optional filtering if needed (e.g. skip temp/git files)
      const base = path.basename(src);
      if (base === '.git' || base === 'node_modules' || base === 'bv-install-log.txt') {
        return false;
      }
      return true;
    }
  });
}

/**
 * Smartly detects the actual program root folder and the relative path of the executable within it.
 * Prevents copying outer wrapper folders and handles standard bin/ directory nesting.
 * 
 * @param {string} baseDir Original target folder path.
 * @param {string} relativeExePath Relative path to the chosen .exe.
 * @returns {{realSourceDir: string, newRelativeExePath: string}}
 */
function detectProgramRoot(baseDir, relativeExePath) {
  const resolvedBase = path.resolve(baseDir);
  const absoluteExePath = path.resolve(resolvedBase, relativeExePath);
  const parentDir = path.dirname(absoluteExePath);
  const parentDirName = path.basename(parentDir).toLowerCase();
  
  const binSubfolders = ['bin', 'win32', 'win64', 'x64', 'x86', 'cli', 'dist', 'binaries', 'commands'];
  
  let realSourceDir = parentDir;
  if (binSubfolders.includes(parentDirName)) {
    const grandParent = path.dirname(parentDir);
    // Ensure we don't go higher than resolvedBase
    if (grandParent.startsWith(resolvedBase)) {
      realSourceDir = grandParent;
    }
  }
  
  // Calculate the new relative executable path from the realSourceDir
  const newRelativeExePath = path.relative(realSourceDir, absoluteExePath).replace(/\\/g, '/');
  
  return {
    realSourceDir,
    newRelativeExePath
  };
}

/**
 * Adds a directory to the user's or machine's PATH environment variable using PowerShell.
 * 
 * @param {string} dirPath Absolute path to add to PATH.
 * @param {boolean} isSystemWide Whether to write to Machine environment.
 * @returns {Promise<void>}
 */
async function addToPath(dirPath, isSystemWide) {
  const target = isSystemWide ? 'Machine' : 'User';
  const resolvedPath = path.resolve(dirPath);
  
  const psScript = `
    $target = "${target}"
    $dir = "${resolvedPath.replace(/"/g, '`"')}"
    $currentPath = [Environment]::GetEnvironmentVariable("Path", $target)
    
    # Check if dir is already in PATH
    $paths = $currentPath -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    if ($paths -notcontains $dir) {
        $newPath = ($paths + $dir) -join ';'
        [Environment]::SetEnvironmentVariable("Path", $newPath, $target)
        
        # Broadcast setting change so open programs and command prompts can update if they support it
        $signature = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
        $type = Add-Type -MemberDefinition $signature -Name "Win32SendMessage" -Namespace "Win32" -PassThru -ErrorAction SilentlyContinue
        $result = [UIntPtr]::Zero
        [Win32.Win32SendMessage]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
    }
  `;
  
  await runPowerShell(psScript);
}

/**
 * Removes a directory from the user's or machine's PATH environment variable.
 * 
 * @param {string} dirPath Absolute path to remove.
 * @param {boolean} isSystemWide Whether to modify Machine environment.
 * @returns {Promise<void>}
 */
async function removeFromPath(dirPath, isSystemWide) {
  const target = isSystemWide ? 'Machine' : 'User';
  const resolvedPath = path.resolve(dirPath);
  
  const psScript = `
    $target = "${target}"
    $dir = "${resolvedPath.replace(/"/g, '`"')}"
    $currentPath = [Environment]::GetEnvironmentVariable("Path", $target)
    
    $paths = $currentPath -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" -and $_ -ne $dir }
    $newPath = $paths -join ';'
    [Environment]::SetEnvironmentVariable("Path", $newPath, $target)
    
    # Broadcast settings change
    $signature = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    $type = Add-Type -MemberDefinition $signature -Name "Win32SendMessage" -Namespace "Win32" -PassThru -ErrorAction SilentlyContinue
    $result = [UIntPtr]::Zero
    [Win32.Win32SendMessage]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
  `;
  
  await runPowerShell(psScript);
}

module.exports = {
  extractZipToTemp,
  extractExeMetadata,
  resolveDestinationPath,
  installFolder,
  detectProgramRoot,
  addToPath,
  removeFromPath
};
