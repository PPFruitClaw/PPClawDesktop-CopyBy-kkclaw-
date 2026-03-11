// KKClaw Startup Hero Banner
// Animation: light-up effect (print gray first, then recolor line by line)

const os = require('os');

// ANSI codes
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  bRed:    '\x1b[91m',
  bGreen:  '\x1b[92m',
  bYellow: '\x1b[93m',
  bCyan:   '\x1b[96m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
};

// Lobster Ball - 42 chars per line, perfectly symmetric
const LOGO = [
  '                ██████████                ',
  '            ████░░░░░░░░░░████            ',
  '          ██░░░░░░████░░░░░░░░██          ',
  '        ██░░░░████████████░░░░░░██        ',
  '       █░░░░██████████████████░░░░█       ',
  '      █░░░██████████████████████░░░█      ',
  '     █░░░████████████████████████░░░█     ',
  '     █░░███████  ████████  ███████░░█     ',
  '     █░░██████████████████████████░░█     ',
  '      █░░░██████████████████████░░░█      ',
  '       █░░░░██████████████████░░░░█       ',
  '        ██░░░░████████████░░░░░░██        ',
  '          ██░░░░░░████░░░░░░░░██          ',
  '            ████░░░░░░░░░░████            ',
  '                ██████████                ',
];

// KKCLAW block letter title
const TITLE = [
  ' ██╗  ██╗██╗  ██╗ ██████╗██╗      █████╗ ██╗    ██╗',
  ' ██║ ██╔╝██║ ██╔╝██╔════╝██║     ██╔══██╗██║    ██║',
  ' █████╔╝ █████╔╝ ██║     ██║     ███████║██║ █╗ ██║',
  ' ██╔═██╗ ██╔═██╗ ██║     ██║     ██╔══██║██║███╗██║',
  ' ██║  ██╗██║  ██╗╚██████╗███████╗██║  ██║╚███╔███╔╝',
  ' ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ',
];

function getSystemInfo(version) {
  const cpus = os.cpus();
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  return {
    platform: `${platform} ${arch}`,
    node: process.versions.node,
    electron: process.versions.electron,
    cpu: `${cpus[0]?.model?.trim() || 'Unknown'} (${cpus.length} cores)`,
    memory: `${totalMem} GB`,
    version: version || '3.1.2',
  };
}

function printSeparator() {
  const width = Math.min(process.stdout.columns || 60, 60);
  console.log(c.gray + '='.repeat(width) + c.reset);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Print startup Hero Banner with light-up animation
 * Phase 1: print everything in dim gray
 * Phase 2: cursor back up, rewrite each line in color (ignite effect)
 */
async function printHero(version, animate = true) {
  const info = getSystemInfo(version);

  // Collect all banner lines: { text, color }
  const bannerLines = [];

  // Logo — single solid bright red, no per-line color variation
  for (const line of LOGO) {
    bannerLines.push({ text: '  ' + line, color: c.bRed });
  }
  bannerLines.push({ text: '', color: '' });

  // Title — bright red bold
  for (const line of TITLE) {
    bannerLines.push({ text: ' ' + line, color: c.bRed + c.bold });
  }

  console.log('');

  if (animate) {
    // ===== Phase 1: print all lines in dim gray =====
    for (const line of bannerLines) {
      process.stdout.write(c.dim + c.gray + line.text + c.reset + '\n');
    }

    await sleep(200); // brief pause before igniting

    // ===== Phase 2: move cursor up, rewrite in color (ignite!) =====
    // Move cursor up N lines
    process.stdout.write('\x1b[' + bannerLines.length + 'A');

    for (const line of bannerLines) {
      process.stdout.write('\x1b[2K\r'); // clear line, carriage return
      if (line.text) {
        process.stdout.write(line.color + line.text + c.reset + '\n');
      } else {
        process.stdout.write('\n');
      }
      await sleep(40);
    }
  } else {
    // No animation: direct color output
    for (const line of bannerLines) {
      if (line.text) {
        console.log(line.color + line.text + c.reset);
      } else {
        console.log('');
      }
    }
  }

  // Subtitle
  console.log('');
  console.log(c.gray + '  ' + c.reset + c.white + c.bold +
    ' Desktop Pet  x  OpenClaw Gateway  x  Live Console' + c.reset);
  console.log('');

  printSeparator();

  // System info panel
  const label = (l) => c.gray + '  ' + l.padEnd(12) + c.reset;
  const val = (v) => c.white + v + c.reset;
  const hi = (v) => c.bCyan + c.bold + v + c.reset;

  console.log(label('Version') + hi('v' + info.version));
  console.log(label('Electron') + val('v' + info.electron) + c.gray + '  |  ' + c.reset + label('Node') + val('v' + info.node));
  console.log(label('Platform') + val(info.platform));
  console.log(label('CPU') + val(info.cpu));
  console.log(label('Memory') + val(info.memory));

  printSeparator();

  console.log(c.yellow + '  >> ' + c.reset + 'Initializing modules...');
  console.log('');
}

/**
 * Print ready banner after Gateway connects
 */
function printReady(port = 18789) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  printSeparator();
  console.log('');
  console.log(c.bGreen + c.bold + '  [OK] KKClaw is ready!' + c.reset);
  console.log('');
  console.log(c.gray + '  Gateway   ' + c.reset + c.green + c.bold + 'http://127.0.0.1:' + port + c.reset);
  console.log(c.gray + '  Started   ' + c.reset + c.white + time + c.reset);
  console.log(c.gray + '  Logs      ' + c.reset + c.dim + 'Gateway output will appear below' + c.reset);
  console.log('');
  printSeparator();
  console.log('');
}

module.exports = { printHero, printReady };
