import fs from 'node:fs/promises';
import path from 'node:path';

import { isPathContained, resolveAssignmentForValue } from '../../multi-user/path-translation.js';
import { unwrapData } from '../opencode-client/envelope.js';

// Saved approvals ("Always allow") are native `PermissionSaved` rows: one
// `{action, resource}` allow rule per row, shared by everyone who works in the
// same native project. The browser never reaches the native list, update or
// remove routes. This owner resolves the project from an explicit, already
// translated request directory, confines every row to that project, and only
// then forwards an update or removal by ID.

/** Kill switch, read on every request: `DEVRYAN_SAVED_APPROVALS=0` disables the routes. */
export const savedApprovalsEnabled = () => process.env.DEVRYAN_SAVED_APPROVALS !== '0';

/** Native IDs are `psv_` plus 26 base62 characters; accept the same alphabet with headroom. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Permission actions are tool and permission names (MCP names are `server_tool`). */
const ACTION_PATTERN = /^[A-Za-z0-9_.:*-]{1,256}$/;
const RESOURCE_MAX_LENGTH = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** The native catalogue's shared bucket for directories outside any repository. */
const GLOBAL_PROJECT_ID = 'global';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, statusCode, message) => Object.assign(new Error(message), { code, statusCode });
const invalid = (message) => fail('opencode_invalid_input', 400, message);
const invalidResponse = () => fail('opencode_invalid_response', 502, 'OpenCode returned an invalid saved approval');
const notFound = () => fail('saved_approval_not_found', 404, 'Saved approval not found');
const forbidden = () => fail('saved_approval_forbidden', 403, 'Directory is outside your assigned workspace');
// Editing can widen a project-wide rule for everyone on the project (a command
// pattern to `*`); revoking only brings prompts back.
const editForbidden = () => fail('saved_approval_edit_forbidden', 403, 'Only administrators can edit saved approvals');

/** Managed non-administrators are confined to their assigned projects. */
export const isRestrictedSavedApprovalPrincipal = (principal) => (
  isRecord(principal) && principal.scope === 'managed' && principal.role !== 'admin'
);

/** Managed non-administrators may list and revoke saved approvals, never edit them. */
export const assertSavedApprovalEditAllowed = (principal) => {
  if (isRestrictedSavedApprovalPrincipal(principal)) throw editForbidden();
};

/**
 * The directory must be explicit (never the host's fallback workspace) and, for
 * a managed non-administrator, inside one of their assignments. The multi-user
 * middleware has already translated public aliases to the canonical repository
 * path, so an assignment root stored through a symlink is compared canonically.
 * @param {unknown} principal
 * @param {unknown} directory
 * @returns {Promise<string>}
 */
export const authorizeSavedApprovalDirectory = async (principal, directory) => {
  if (typeof directory !== 'string' || !directory || !path.isAbsolute(directory)) {
    throw invalid('An absolute project directory is required');
  }
  if (!isRestrictedSavedApprovalPrincipal(principal) || resolveAssignmentForValue(principal, directory)) return directory;
  const assignments = Array.isArray(principal.assignments) ? principal.assignments : [];
  for (const assignment of assignments) {
    for (const root of [assignment?.repositoryPath, assignment?.worktreeContainerPath]) {
      if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
      const canonical = await fs.realpath(root).catch(() => null);
      if (canonical && isPathContained(canonical, directory)) return directory;
    }
  }
  throw forbidden();
};

/** @param {unknown} value */
export const isSavedApprovalId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

/**
 * The update body: `action` and/or `resource`, nothing else.
 * @param {unknown} body
 * @returns {{ action?: string, resource?: string }}
 */
export const parseSavedApprovalUpdate = (body) => {
  if (!isRecord(body)) throw invalid('Request body must be an object');
  if (Object.keys(body).some((key) => key !== 'action' && key !== 'resource')) {
    throw invalid('Request body contains unsupported fields');
  }
  /** @type {{ action?: string, resource?: string }} */
  const update = {};
  if (body.action !== undefined) {
    if (typeof body.action !== 'string' || !ACTION_PATTERN.test(body.action)) throw invalid('action must be a permission name');
    update.action = body.action;
  }
  if (body.resource !== undefined) {
    if (typeof body.resource !== 'string' || !body.resource.trim()) throw invalid('resource must be a non-empty string');
    if (body.resource.length > RESOURCE_MAX_LENGTH) throw invalid(`resource must be at most ${RESOURCE_MAX_LENGTH} characters`);
    if (CONTROL_CHARACTERS.test(body.resource)) throw invalid('resource must not contain control characters');
    update.resource = body.resource;
  }
  if (update.action === undefined && update.resource === undefined) throw invalid('Provide an action or a resource');
  return update;
};

/**
 * Native `PermissionSaved.Info` -> the DevRyan shape. A row from another
 * project is a native defect and fails closed.
 * @param {unknown} row
 * @param {string} projectID
 */
export const toSavedApproval = (row, projectID) => {
  if (!isRecord(row) || !isSavedApprovalId(row.id) || row.projectID !== projectID
    || typeof row.action !== 'string' || typeof row.resource !== 'string' || !isRecord(row.time)
    || !Number.isFinite(row.time.created) || !Number.isFinite(row.time.updated)) throw invalidResponse();
  return {
    id: row.id,
    projectID,
    action: row.action,
    resource: row.resource,
    anyInput: row.resource === '*',
    time: { created: row.time.created, updated: row.time.updated },
  };
};

const order = (left, right) => left.action.localeCompare(right.action)
  || left.resource.localeCompare(right.resource) || left.id.localeCompare(right.id);

/**
 * @param {{ request: (spec: Record<string, unknown>) => Promise<unknown> }} deps the server-audience v2 requester
 */
export const createSavedPermissionFacade = ({ request }) => {
  if (typeof request !== 'function') throw new TypeError('createSavedPermissionFacade requires a requester');

  /** @param {{ directory: string, signal?: AbortSignal, restricted?: boolean }} scope */
  const projectOf = async ({ directory, signal, restricted }) => {
    const location = unwrapData(await request({ label: 'browser.permission.saved.location', path: '/api/location', directory, signal }));
    const projectID = isRecord(location) && isRecord(location.project) ? location.project.id : undefined;
    if (typeof projectID !== 'string' || !projectID) throw fail('opencode_invalid_response', 502, 'OpenCode returned no project for this directory');
    // Directories outside a repository share one native bucket that no
    // assignment owns.
    if (restricted && projectID === GLOBAL_PROJECT_ID) throw forbidden();
    return projectID;
  };

  const listRows = async (projectID, signal) => {
    const rows = unwrapData(await request({ label: 'browser.permission.saved.list', path: '/api/permission/saved', query: { projectID }, signal }));
    if (!Array.isArray(rows)) throw invalidResponse();
    return rows.map((row) => toSavedApproval(row, projectID)).sort(order);
  };

  /** The row must belong to the directory's project before any write by ID. */
  const owned = async (id, scope) => {
    if (!isSavedApprovalId(id)) throw notFound();
    const projectID = await projectOf(scope);
    if (!(await listRows(projectID, scope.signal)).some((row) => row.id === id)) throw notFound();
    return projectID;
  };

  return {
    /** @param {{ directory: string, signal?: AbortSignal, restricted?: boolean }} scope */
    async list(scope) {
      const projectID = await projectOf(scope);
      return { projectID, approvals: await listRows(projectID, scope.signal) };
    },
    /**
     * @param {string} id
     * @param {{ action?: string, resource?: string }} update
     * @param {{ directory: string, signal?: AbortSignal, restricted?: boolean }} scope
     */
    async update(id, update, scope) {
      if (scope.restricted) throw editForbidden();
      const projectID = await owned(id, scope);
      let body;
      try {
        body = await request({ label: 'browser.permission.saved.update', method: 'PATCH',
          path: `/api/permission/saved/${encodeURIComponent(id)}`, body: update, signal: scope.signal });
      } catch (error) {
        if (error?.statusCode === 404) throw notFound();
        if (error?.statusCode === 409) throw fail('saved_approval_conflict', 409, 'This project already has a saved approval for that tool and input');
        throw error;
      }
      return toSavedApproval(unwrapData(body), projectID);
    },
    /**
     * @param {string} id
     * @param {{ directory: string, signal?: AbortSignal, restricted?: boolean }} scope
     */
    async remove(id, scope) {
      await owned(id, scope);
      await request({ label: 'browser.permission.saved.remove', method: 'DELETE',
        path: `/api/permission/saved/${encodeURIComponent(id)}`, signal: scope.signal });
      return { id, removed: true };
    },
  };
};
