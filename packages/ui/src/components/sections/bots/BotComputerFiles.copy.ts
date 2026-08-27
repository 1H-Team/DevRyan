import type { BotComputerFiles as BotComputerFilesResult } from '@/lib/botsApi';

export const botComputerFilesUnavailableCopy = (state: BotComputerFilesResult['state']) => {
  if (state === 'unsupported') {
    return {
      title: 'Computer files need the DevRyan desktop app.',
      detail: 'Open this Bot in the desktop app to manage its local runtime.',
    };
  }
  if (state === 'docker_not_installed') {
    return {
      title: 'Docker Desktop is required for this Bot’s computer.',
      detail: 'Install Docker Desktop, then activate the Bot to finish setup.',
    };
  }
  if (state === 'docker_stopped') {
    return {
      title: 'Docker Desktop is not running.',
      detail: 'Start Docker, then activate the Bot. DevRyan will finish the remaining setup automatically.',
    };
  }
  if (state === 'setup_required') {
    return {
      title: 'This Bot’s computer has not been set up yet.',
      detail: 'Activating the Bot prepares it automatically. No files are required.',
    };
  }
  if (state === 'image_update_available') {
    return {
      title: 'This Bot’s computer needs an update.',
      detail: 'Applying the Bot configuration installs the bundled runtime update automatically.',
    };
  }
  if (state === 'runtime_degraded' || state === 'runtime_unavailable') {
    return {
      title: 'This Bot’s computer needs runtime recovery.',
      detail: 'Applying the Bot configuration retries setup and reports only anything that still needs you.',
    };
  }
  return {
    title: 'This Bot’s computer is not running.',
    detail: 'Files appear here once the Bot starts working. Nothing is lost while it is off.',
  };
};
