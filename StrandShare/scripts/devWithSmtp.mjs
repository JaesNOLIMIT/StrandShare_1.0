import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;

function run(name, command, args, { required = true } = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const printedCode = code ?? 'null';
    const printedSignal = signal ?? 'null';

    if (!required) {
      console.warn(`[dev] ${name} exited (code=${printedCode} signal=${printedSignal}). Continuing web dev server.`);
      return;
    }

    console.log(`[dev] ${name} exited (code=${printedCode} signal=${printedSignal})`);
    shutdown(code ?? 0);
  });

  children.push(child);
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // no-op
    }
  }
  setTimeout(() => process.exit(exitCode), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('web', 'npm', ['run', 'start:web'], { required: true });
run('smtp-trigger', 'npm', ['run', 'smtp:trigger:server'], { required: false });
run('wig-catalog-local-ai', 'npm', ['run', 'ai:start'], { required: false });
