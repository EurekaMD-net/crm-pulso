import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { processCrmIpc } from '../../crm/src/ipc-handlers.js';

import {
  DATA_DIR,
  IPC_FALLBACK_POLL_INTERVAL,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;
let isProcessing = false;

// ── Watcher state ──────────────────────────────────────────────────────
interface WatcherState {
  baseWatcher: fs.FSWatcher | null;
  dirWatchers: Map<string, { tasks?: fs.FSWatcher; messages?: fs.FSWatcher }>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  watcherMode: 'watching' | 'polling';
}

const wState: WatcherState = {
  baseWatcher: null,
  dirWatchers: new Map(),
  debounceTimer: null,
  fallbackTimer: null,
  watcherMode: 'polling',
};

// ── Core processing (unchanged logic) ──────────────────────────────────

async function processIpcFiles(
  ipcBaseDir: string,
  deps: IpcDeps,
): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        try {
          return (
            fs.statSync(path.join(ipcBaseDir, f)).isDirectory() &&
            f !== 'errors'
          );
        } catch {
          return false;
        }
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }
  } finally {
    isProcessing = false;
  }
}

// ── fs.watch machinery ─────────────────────────────────────────────────

function triggerDebounced(ipcBaseDir: string, deps: IpcDeps): void {
  if (wState.debounceTimer) clearTimeout(wState.debounceTimer);
  wState.debounceTimer = setTimeout(() => {
    wState.debounceTimer = null;
    processIpcFiles(ipcBaseDir, deps);
  }, 100);
}

function watchGroupDir(ipcBaseDir: string, group: string, deps: IpcDeps): void {
  if (wState.dirWatchers.has(group)) return;

  const entry: { tasks?: fs.FSWatcher; messages?: fs.FSWatcher } = {};

  for (const subdir of ['tasks', 'messages'] as const) {
    const dirPath = path.join(ipcBaseDir, group, subdir);
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const watcher = fs.watch(dirPath, (_event, filename) => {
        if (filename && filename.endsWith('.json')) {
          triggerDebounced(ipcBaseDir, deps);
        }
      });
      watcher.on('error', (err) => {
        logger.warn({ err, group, subdir }, 'Group dir watcher error');
        watcher.close();
      });
      if (watcher.unref) watcher.unref();
      entry[subdir] = watcher;
    } catch (err) {
      logger.warn({ err, group, subdir }, 'Failed to watch group subdir');
    }
  }

  wState.dirWatchers.set(group, entry);
}

function setupWatchers(ipcBaseDir: string, deps: IpcDeps): void {
  try {
    wState.baseWatcher = fs.watch(ipcBaseDir, (eventType, filename) => {
      if (eventType === 'rename' && filename && filename !== 'errors') {
        const dirPath = path.join(ipcBaseDir, filename);
        try {
          if (fs.statSync(dirPath).isDirectory()) {
            watchGroupDir(ipcBaseDir, filename, deps);
          }
        } catch {
          /* dir may not exist yet */
        }
      }
    });
    wState.baseWatcher.on('error', (err) => {
      logger.warn({ err }, 'Base IPC watcher error, falling back to polling');
      teardownWatchers();
      wState.watcherMode = 'polling';
    });
    if (wState.baseWatcher.unref) wState.baseWatcher.unref();
  } catch (err) {
    logger.warn({ err }, 'Failed to setup base IPC watcher');
    wState.watcherMode = 'polling';
    return;
  }

  // Watch existing group directories
  try {
    const groups = fs.readdirSync(ipcBaseDir).filter((f) => {
      try {
        return (
          fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors'
        );
      } catch {
        return false;
      }
    });
    for (const group of groups) {
      watchGroupDir(ipcBaseDir, group, deps);
    }
    wState.watcherMode = 'watching';
    logger.info({ groups: groups.length }, 'IPC file watchers active');
  } catch (err) {
    logger.warn({ err }, 'Failed to enumerate IPC dirs for watching');
    wState.watcherMode = 'polling';
  }
}

function teardownWatchers(): void {
  if (wState.baseWatcher) {
    wState.baseWatcher.close();
    wState.baseWatcher = null;
  }
  for (const [, entry] of wState.dirWatchers) {
    entry.tasks?.close();
    entry.messages?.close();
  }
  wState.dirWatchers.clear();
}

// ── Public API ─────────────────────────────────────────────────────────

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Try fs.watch (inotify on Linux)
  setupWatchers(ipcBaseDir, deps);

  // Fallback/safety-net poll loop
  const fallbackPoll = async () => {
    await processIpcFiles(ipcBaseDir, deps);
    const interval =
      wState.watcherMode === 'watching'
        ? IPC_FALLBACK_POLL_INTERVAL
        : IPC_POLL_INTERVAL;
    wState.fallbackTimer = setTimeout(fallbackPoll, interval);
    if (wState.fallbackTimer.unref) wState.fallbackTimer.unref();
  };

  fallbackPoll();
  logger.info({ mode: wState.watcherMode }, 'IPC watcher started');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default: {
      // CRM hook: delegate unknown IPC types to CRM handler
      try {
        const handled = await processCrmIpc(
          data as Record<string, unknown>,
          sourceGroup,
          isMain,
          deps,
        );
        if (!handled) {
          logger.warn({ type: data.type }, 'Unknown IPC task type');
        }
      } catch (err) {
        logger.error(
          { err, type: data.type, sourceGroup },
          'CRM IPC handler threw',
        );
      }
    }
  }
}
