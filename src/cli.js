const { Command } = require('commander');
const fs = require('fs').promises;
const path = require('path');
const picocolors = require('picocolors');
const { detectExecutables } = require('./core/detector');
const { runInstallerWizard } = require('./ui/prompts');
const pkg = require('../package.json');

const program = new Command();

program
  .name('bv-install')
  .description('Transform Windows portable folders into native installed applications.')
  .version(pkg.version)
  .argument('[folder]', 'Path to the portable application folder', '.')
  .option('-s, --just-scan', 'Scan the folder, detect the main executable, and exit')
  .option('--just-add-path', 'Add the target folder directly to the environment PATH and exit')
  .action(async (folder, options) => {
    try {
      const resolvedPath = path.resolve(folder);
      
      // Verify path existence and directory type
      let stats;
      try {
        stats = await fs.stat(resolvedPath);
      } catch (e) {
        console.error(picocolors.red(`❌ Target folder does not exist: ${resolvedPath}`));
        process.exit(1);
      }
      
      const isZip = stats.isFile() && resolvedPath.toLowerCase().endsWith('.zip');
      if (!stats.isDirectory() && !isZip) {
        console.error(picocolors.red(`❌ Target path is not a directory or a .zip file: ${resolvedPath}`));
        process.exit(1);
      }

      // If --just-add-path is selected
      if (options.justAddPath) {
        if (isZip) {
          console.error(picocolors.red(`❌ Target path cannot be a .zip file for path integration: ${resolvedPath}`));
          process.exit(1);
        }

        const { checkIsAdmin } = require('./core/registry');
        const { addToPath } = require('./core/installer');
        
        const isAdmin = await checkIsAdmin();
        const modeStr = isAdmin ? 'system-wide' : 'local user';
        
        console.log(picocolors.cyan(`\n┌  bv-install`));
        console.log(`${picocolors.cyan('│')}  adding folder to environment path (${modeStr})`);
        
        try {
          await addToPath(resolvedPath, isAdmin);
          console.log(`${picocolors.cyan('│')}  added: ${picocolors.bold(resolvedPath)}`);
          console.log(`${picocolors.cyan('└')}  path updated successfully\n`);
        } catch (e) {
          console.log(`${picocolors.cyan('│')}  ${picocolors.red('failed')}`);
          console.log(`${picocolors.cyan('└')}  ${picocolors.red('error: ' + e.message)}\n`);
          process.exit(1);
        }
        process.exit(0);
      }

      // If --just-scan is selected
      if (options.justScan) {
        console.log(picocolors.cyan(picocolors.bold('\n🔍 scan results')));
        console.log(`📂 target directory: ${picocolors.dim(resolvedPath)}\n`);

        let scanPath = resolvedPath;
        let tempDirToClean = null;

        if (isZip) {
          try {
            const { extractZipToTemp } = require('./core/installer');
            const zipResult = await extractZipToTemp(resolvedPath);
            scanPath = zipResult.activeSource;
            tempDirToClean = zipResult.tempDir;
          } catch (e) {
            console.error(picocolors.red(`❌ failed to extract zip archive: ${e.message}`));
            process.exit(1);
          }
        }

        try {
          const { candidates, recommended } = await detectExecutables(scanPath);

          if (candidates.length === 0) {
            console.log(picocolors.red('❌ no executables (.exe) found in this directory.'));
            process.exit(0);
          }

          console.log(`found ${picocolors.bold(candidates.length)} executable candidate(s):\n`);

          candidates.forEach((c, idx) => {
            const isRec = c.name === recommended;
            const sizeMB = (c.size / (1024 * 1024)).toFixed(1);
            const typeStr = c.isCli ? 'cli' : 'gui';
            
            let candidateLine = `  ${idx + 1}. ${picocolors.bold(c.name)} (${sizeMB} MB) ${picocolors.dim(`[${typeStr}]`)}`;
            if (isRec) {
              candidateLine += `  ${picocolors.green('★ [recommended]')}`;
            }
            console.log(candidateLine);
            console.log(`     ↳ heuristic score: ${c.score > 0 ? picocolors.green(c.score) : picocolors.yellow(c.score)}`);
          });

          console.log(`\n🎯 recommended main exe: ${picocolors.green(picocolors.bold(recommended))}\n`);
        } finally {
          if (tempDirToClean) {
            await fs.rm(tempDirToClean, { recursive: true, force: true }).catch(() => {});
          }
        }
        process.exit(0);
      }

      await runInstallerWizard(resolvedPath);
    } catch (err) {
      console.error(picocolors.red(`❌ Fatal error: ${err.message}`));
      process.exit(1);
    }
  });

module.exports = {
  program
};
