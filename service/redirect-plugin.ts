// An optional OpenCode plugin the user can turn on from the setup check. Agents asked to
// track work sometimes file it with OpenChamber's project tool instead of the session's list.
export const REDIRECT_FILE = 'session-todos-redirect.js';
export const REDIRECT_MARK = '// Installed by Session Todos.';

export const REDIRECT_PLUGIN = `${REDIRECT_MARK} Turn it off from its setup check, or delete this file.
//
// Stops agents creating project backlog todos with openchamber_knowledge and points them at
// todowrite. Notes, plans, edits to existing items and the Project panel are untouched.
const TOOL = 'openchamber_knowledge';
const MESSAGE = 'Not saved, and retrying will not save it: agents do not create project backlog todos here. To track work in this session, use the todowrite tool. If the user wants a backlog item, tell them to add it in the Project panel.';

export const isNewBacklogTodo = (tool, input) => {
  if (!String(tool ?? '').endsWith(TOOL) || typeof input !== 'object' || input === null) return false;
  if (input.action !== 'knowledge.save') return false;
  // The arguments sit beside action, or under parameters, depending on the harness.
  const parameters = typeof input.parameters === 'object' && input.parameters !== null ? input.parameters : input;
  return parameters.kind === 'todo' && !parameters.id;
};

export default {
  id: 'session-todos.redirect-knowledge-todos',
  async setup(context) {
    if (typeof context?.tool?.hook !== 'function') return;
    await context.tool.hook('execute.before', async (event) => {
      if (isNewBacklogTodo(event?.tool, event?.input ?? event?.args)) throw new Error(MESSAGE);
    });
  },
};
`;
