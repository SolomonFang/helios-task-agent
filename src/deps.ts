import { execFileSync } from 'child_process';

/** Shared dependency probe: is lark-cli installed and runnable? */
export function checkLarkCli(): boolean {
  try {
    execFileSync('lark-cli', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
