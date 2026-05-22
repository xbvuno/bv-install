const { exec } = require('child_process');

/**
 * Runs a PowerShell command or script using the UTF-16LE Base64 EncodedCommand bridge.
 * This guarantees 100% safety against quote escaping issues, weird paths, and newlines.
 * 
 * @param {string} script The PowerShell script text to execute.
 * @returns {Promise<string>} stdout output of the script.
 */
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    // PowerShell's EncodedCommand requires UTF-16LE byte encoding converted to Base64
    const buffer = Buffer.from(script, 'utf16le');
    const base64 = buffer.toString('base64');
    
    const command = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${base64}`;
    
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

module.exports = {
  runPowerShell
};
