const asNonEmptyString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseProjectID = (req) => asNonEmptyString(req?.params?.projectId);
const parseTaskID = (req) => asNonEmptyString(req?.params?.taskId);
const normalizeBranchName = (value) => String(value || '').trim()
  .replace(/^refs\/heads\//, '')
  .replace(/^heads\//, '')
  .replace(/^refs\/remotes\/[^/]+\//, '')
  .replace(/^remotes\/[^/]+\//, '');

export const canReceiveProjectMetadataEvent = (client, projectId) => (
  client?.isAdmin === true
  || (client?.projectIds instanceof Set && client.projectIds.has(projectId))
);

export const registerScheduledTaskRoutes = (app, dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    getOpenChamberEventClients,
    writeSseEvent,
    resolveManagedProject,
  } = dependencies;

  const isAdministrator = (principal) => !principal || principal.scope === 'local-admin' || principal.role === 'admin';
  const isPersonalManagedUser = (principal) => principal?.scope === 'managed' && principal.role !== 'admin';
  const filterTasksForPrincipal = (tasks, principal) => isAdministrator(principal)
    ? tasks
    : tasks.filter((task) => task.ownerUserId === principal?.id);

  const resolveProjectForRequest = async (req, projectID) => {
    if (req.principal?.scope === 'managed' && typeof resolveManagedProject === 'function') {
      const managed = await resolveManagedProject(req, projectID);
      if (managed?.project) return managed.project;
      if (!isAdministrator(req.principal)) return null;
    }
    return findProjectByID(projectID);
  };

  const assignedBranches = (principal, projectID) => (principal?.assignments || [])
    .filter((entry) => entry.projectId === projectID)
    .map((entry) => ({ name: normalizeBranchName(entry.branchName), isDefault: entry.isDefault === true }));

  const resolveTaskBranch = ({ req, projectID, project, taskInput, existingTask }) => {
    const grants = assignedBranches(req.principal, projectID);
    const requested = normalizeBranchName(asNonEmptyString(taskInput?.target?.branchName)
      || asNonEmptyString(existingTask?.target?.branchName)
      || grants.find((entry) => entry.isDefault)?.name
      || grants[0]?.name
      || asNonEmptyString(project?.default_branch)
      || asNonEmptyString(project?.defaultBranch));
    if (!requested) {
      if (req.principal?.scope === 'managed') throw new Error('target.branchName is required');
      return null;
    }
    const taskBelongsToPrincipal = !existingTask || existingTask.ownerUserId === req.principal?.id;
    if (req.principal?.scope === 'managed' && taskBelongsToPrincipal && !grants.some((entry) => entry.name === requested)) {
      throw Object.assign(new Error('Scheduled tasks can only target an assigned branch'), { statusCode: 403 });
    }
    return requested;
  };

  const findProjectByID = async (projectID) => {
    const settings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(settings?.projects || []);
    return projects.find((project) => project.id === projectID) || null;
  };

  app.get('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const project = await resolveProjectForRequest(req, projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const tasks = filterTasksForPrincipal(await projectConfigRuntime.listScheduledTasks(projectID), req.principal);
      return res.json({ tasks });
    } catch (error) {
      console.error('[ScheduledTasks] failed to load tasks:', error);
      return res.status(500).json({ error: 'Failed to load scheduled tasks' });
    }
  });

  app.put('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const taskInput = req.body && typeof req.body === 'object' ? req.body.task : null;
    if (!taskInput || typeof taskInput !== 'object') {
      return res.status(400).json({ error: 'task payload is required' });
    }

    try {
      const project = await resolveProjectForRequest(req, projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const currentTasks = await projectConfigRuntime.listScheduledTasks(projectID);
      const incomingTaskID = asNonEmptyString(taskInput.id);
      const existingTask = incomingTaskID ? currentTasks.find((task) => task.id === incomingTaskID) || null : null;
      if (incomingTaskID && !existingTask) return res.status(404).json({ error: 'Task not found' });
      if (existingTask && !isAdministrator(req.principal) && existingTask.ownerUserId !== req.principal?.id) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const ownerUserId = existingTask?.ownerUserId
        || (req.principal?.scope === 'managed' ? req.principal.id : null);
      const targetBranchName = resolveTaskBranch({ req, projectID, project, taskInput, existingTask });
      const upserted = await projectConfigRuntime.upsertScheduledTask(projectID, taskInput, {
        ownerUserId,
        targetBranchName,
      });
      await scheduledTasksRuntime.syncProject(projectID);
      const freshTasks = filterTasksForPrincipal(await projectConfigRuntime.listScheduledTasks(projectID), req.principal);
      const freshTask = freshTasks.find((task) => task.id === upserted.task.id) || upserted.task;

      return res.json({
        tasks: freshTasks,
        task: freshTask,
        created: upserted.created,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const statusCode = error?.statusCode || (message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid') ? 400 : 500);
      if (statusCode === 500) {
        console.error('[ScheduledTasks] failed to save task:', error);
      }
      return res.status(statusCode).json({ error: message });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      const project = await resolveProjectForRequest(req, projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const currentTasks = await projectConfigRuntime.listScheduledTasks(projectID);
      const task = currentTasks.find((entry) => entry.id === taskID);
      if (!task || (!isAdministrator(req.principal) && task.ownerUserId !== req.principal?.id)) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const result = await projectConfigRuntime.deleteScheduledTask(projectID, taskID);
      if (!result.deleted) {
        return res.status(404).json({ error: 'Task not found' });
      }
      await scheduledTasksRuntime.syncProject(projectID);
      const freshTasks = filterTasksForPrincipal(await projectConfigRuntime.listScheduledTasks(projectID), req.principal);
      return res.json({ tasks: freshTasks });
    } catch (error) {
      console.error('[ScheduledTasks] failed to delete task:', error);
      return res.status(500).json({ error: 'Failed to delete scheduled task' });
    }
  });

  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/run', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      const project = await resolveProjectForRequest(req, projectID);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const task = (await projectConfigRuntime.listScheduledTasks(projectID)).find((entry) => entry.id === taskID);
      if (!task || (!isAdministrator(req.principal) && task.ownerUserId !== req.principal?.id)) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const result = await scheduledTasksRuntime.runNow(projectID, taskID);
      if (result.running || result.queued) {
        return res.status(409).json({ error: result.error || 'Task already running' });
      }
      if (result.skipped) {
        return res.status(404).json({ error: 'Task not found or disabled' });
      }
      if (!result.ok) {
        return res.status(500).json({
          error: result.error || 'Task run failed',
          task: result.task,
        });
      }

      return res.json({
        ok: true,
        task: result.task,
        sessionId: result.sessionID,
      });
    } catch (error) {
      console.error('[ScheduledTasks] failed to run task:', error);
      return res.status(500).json({ error: 'Failed to run scheduled task' });
    }
  });

  app.get('/api/openchamber/scheduled-tasks/status', async (req, res) => {
    try {
      if (isAdministrator(req.principal) && typeof scheduledTasksRuntime.getStatus === 'function') {
        return res.json(scheduledTasksRuntime.getStatus());
      }

      const settings = await readSettingsFromDiskMigrated();
      const projects = isPersonalManagedUser(req.principal)
        ? [...new Map((req.principal.assignments || []).map((entry) => [entry.projectId, { id: entry.projectId }])).values()]
        : sanitizeProjects(settings?.projects || []);

      let enabledCount = 0;
      let runningCount = 0;

      for (const project of projects) {
        try {
          const tasks = filterTasksForPrincipal(await projectConfigRuntime.listScheduledTasks(project.id), req.principal);
          for (const task of tasks) {
            if (task?.enabled) {
              enabledCount += 1;
            }
            if (task?.state?.lastStatus === 'running') {
              runningCount += 1;
            }
          }
        } catch {
        }
      }

      return res.json({
        hasEnabledScheduledTasks: enabledCount > 0,
        hasRunningScheduledTasks: runningCount > 0,
        enabledScheduledTasksCount: enabledCount,
        runningScheduledTasksCount: runningCount,
      });
    } catch (error) {
      console.error('[ScheduledTasks] failed to resolve scheduled task status:', error);
      return res.status(500).json({ error: 'Failed to resolve scheduled task status' });
    }
  });

  app.get('/api/openchamber/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getOpenChamberEventClients();
    const client = {
      response: res,
      principalId: req.principal?.scope === 'managed' ? req.principal.id : null,
      isAdmin: isAdministrator(req.principal),
      projectIds: new Set((req.principal?.assignments || []).map((entry) => entry.projectId).filter(Boolean)),
    };
    clients.add(client);

    try {
      writeSseEvent(res, {
        type: 'openchamber:event-stream-ready',
        properties: {
          connectedAt: Date.now(),
        },
      });
    } catch {
    }

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'openchamber:heartbeat',
          properties: {
            timestamp: Date.now(),
          },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(client);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  });
};
