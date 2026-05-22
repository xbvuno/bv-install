const fs = require('fs').promises;
const path = require('path');

// Exclude patterns for executables that are highly unlikely to be the main app.
const EXCLUDE_REGEX = /(?:uninstall|uninst|setup|install|update|patch|crashpad_handler|notification_helper|elevate|helper|config|settings|process_helper|register|activate|diagnostics|repair|report|wizard)/i;

/**
 * Parses the PE header of an executable to detect its subsystem.
 * 2 = Windows GUI, 3 = Windows CUI (Console / CLI)
 * 
 * @param {string} filePath Absolute path to the .exe file.
 * @returns {Promise<number>}
 */
async function detectExeSubsystem(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    
    // Read PE header offset at 0x3C (4 bytes)
    const peOffsetBuffer = Buffer.alloc(4);
    await handle.read(peOffsetBuffer, 0, 4, 0x3C);
    const peOffset = peOffsetBuffer.readUInt32LE(0);
    
    // Subsystem is at offset 68 of the Optional Header.
    // PE signature is 4 bytes, COFF header is 20 bytes, so Optional Header starts at peOffset + 24.
    // Total offset = peOffset + 24 + 68 = peOffset + 92.
    const subsystemBuffer = Buffer.alloc(2);
    await handle.read(subsystemBuffer, 0, 2, peOffset + 92);
    const subsystem = subsystemBuffer.readUInt16LE(0);
    
    return subsystem;
  } catch (e) {
    return 0; // Unknown
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

/**
 * Recursively scans a directory for .exe files up to a maximum depth.
 * 
 * @param {string} dir Current directory path to scan.
 * @param {string} baseDir Base target directory.
 * @param {number} depth Current recursive depth.
 * @param {number} maxDepth Maximum search depth.
 * @returns {Promise<Array<{name: string, path: string, size: number, subsystem: number, isCli: boolean}>>}
 */
async function findExecutablesRecursive(dir, baseDir, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  
  let files;
  try {
    files = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  
  let results = [];
  
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      // Skip irrelevant folders to keep scans clean and rapid
      if (['node_modules', '.git', 'temp', 'tmp', 'cache', 'logs'].includes(file.name.toLowerCase())) {
        continue;
      }
      const subResults = await findExecutablesRecursive(fullPath, baseDir, depth + 1, maxDepth);
      results = results.concat(subResults);
    } else if (file.isFile() && file.name.toLowerCase().endsWith('.exe')) {
      try {
        const stats = await fs.stat(fullPath);
        // Use relative path with forward slashes as candidate name
        const relativeName = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const subsystem = await detectExeSubsystem(fullPath);
        results.push({
          name: relativeName,
          path: fullPath,
          size: stats.size,
          subsystem,
          isCli: subsystem === 3
        });
      } catch (e) {
        // Skip files that can't be read
      }
    }
  }
  
  return results;
}

/**
 * Scan a directory recursively for .exe files and run heuristics to determine the main application.
 * 
 * @param {string} targetDir Absolute path to the portable app directory.
 * @returns {Promise<{candidates: Array<{name: string, path: string, size: number, score: number}>, recommended: string|null}>}
 */
async function detectExecutables(targetDir) {
  const resolvedDir = path.resolve(targetDir);
  const folderName = path.basename(resolvedDir);
  
  // Find all .exe files recursively
  const exeFiles = await findExecutablesRecursive(resolvedDir, resolvedDir);
  
  if (exeFiles.length === 0) {
    return { candidates: [], recommended: null };
  }
  
  // Apply heuristics and scoring
  const candidates = exeFiles.map(exe => {
    const baseName = path.basename(exe.name, '.exe');
    let score = 0;
    
    // Rule 1: Exclude noise
    const isExcluded = EXCLUDE_REGEX.test(baseName);
    if (isExcluded) {
      score -= 100;
    }
    
    // Rule 2: Matches folder name exactly (case insensitive)
    if (baseName.toLowerCase() === folderName.toLowerCase()) {
      score += 100;
    }
    // Rule 3: folderName contains baseName or baseName contains folderName
    else if (folderName.toLowerCase().includes(baseName.toLowerCase())) {
      score += 50;
    }
    else if (baseName.toLowerCase().includes(folderName.toLowerCase())) {
      score += 40;
    }
    
    // Rule 4: Match part of folder name (common prefix/suffix)
    // For example "MyCoolAppPortable" vs "MyCoolApp"
    const cleanedFolderName = folderName.replace(/(?:portable|win|windows|x64|x86|v[0-9.]+)/ig, '');
    const cleanedBaseName = baseName.replace(/(?:portable|win|windows|x64|x86|v[0-9.]+)/ig, '');
    if (cleanedFolderName.toLowerCase() === cleanedBaseName.toLowerCase()) {
      score += 80;
    } else if (cleanedFolderName.toLowerCase().includes(cleanedBaseName.toLowerCase()) || 
               cleanedBaseName.toLowerCase().includes(cleanedFolderName.toLowerCase())) {
      score += 30;
    }
    
    // Rule 5: Prefer larger files over tiny ones (main exe is usually larger than simple launchers/helpers)
    // Add small score based on size (up to 10 points for large files)
    const sizeMB = exe.size / (1024 * 1024);
    score += Math.min(10, sizeMB);
    
    return {
      ...exe,
      score: Math.round(score * 100) / 100
    };
  });
  
  // Sort candidates by score descending, then by size descending
  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.size - a.size;
  });
  
  // Recommended is the top candidate if its score is reasonably high (or just the top one if any)
  const recommended = candidates.length > 0 ? candidates[0].name : null;
  
  return {
    candidates,
    recommended
  };
}

module.exports = {
  detectExecutables
};
