import os from 'node:os';
import path from 'node:path';

export function hostDirectory(desktopUserData?: string): string {
  if (process.env.DESKAI_HOST_DIR) return path.resolve(process.env.DESKAI_HOST_DIR);
  const config = process.platform === 'win32' ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(desktopUserData ?? path.join(config, 'DeskAI2'), 'host');
}
