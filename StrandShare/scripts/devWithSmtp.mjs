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
// SMTP is a Windows sign-in worker managed independently of localhost.
// Starting the React dev server only ensures that worker is available.
run('smtp-worker', 'npm', ['run', 'smtp:start'], { required: false });
// The lightweight controller keeps the local AI worker ready by default.
run('wig-catalog-ai-controller', 'npm', ['run', 'ai:controller:start'], { required: false });
