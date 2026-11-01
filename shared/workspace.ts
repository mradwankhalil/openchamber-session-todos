import type { GuestProject, GuestSessionRecord, connectHost } from '@openchamber/sdk';

// Session names, projects, parents and live activity, from the host's own stores.
// Refused or unavailable means fewer labels, never a broken list.

type Host = ReturnType<typeof connectHost>;

const MAX_PROJECT_SUBSCRIPTIONS = 28;

export type Workspace = {
  readonly available: boolean;
  readonly projects: GuestProject[];
  readonly sessions: GuestSessionRecord[];
  byId(id: string): GuestSessionRecord | undefined;
  childrenOf(id: string): GuestSessionRecord[];
  start(): void;
};

export const createWorkspace = (host: Host, onChange: () => void): Workspace => {
  let available = false;
  let projects: GuestProject[] = [];
  const perProject = new Map<string, GuestSessionRecord[]>();
  const stops = new Map<string, () => void>();
  let index = new Map<string, GuestSessionRecord>();
  let sessions: GuestSessionRecord[] = [];

  const rebuild = (): void => {
    sessions = [...perProject.values()].flat();
    index = new Map(sessions.map((session) => [session.id, session]));
    onChange();
  };

  const follow = async (project: GuestProject): Promise<void> => {
    if (stops.has(project.id) || stops.size >= MAX_PROJECT_SUBSCRIPTIONS) return;
    stops.set(project.id, () => undefined);
    try {
      const stop = await host.onSessions(project.id, (snapshot) => {
        if (snapshot.state === 'error' && snapshot.sessions.length === 0) return;
        perProject.set(project.id, snapshot.sessions);
        rebuild();
      });
      stops.set(project.id, stop);
    } catch {
      stops.delete(project.id);
    }
  };

  return {
    get available() { return available; },
    get projects() { return projects; },
    get sessions() { return sessions; },
    byId: (id) => index.get(id),
    childrenOf: (id) => sessions.filter((session) => session.parentId === id),
    start() {
      host.onProjects((snapshot) => {
        available = true;
        projects = snapshot.projects;
        for (const project of projects) void follow(project);
        onChange();
      }).catch(() => {
        available = false;
      });
    },
  };
};
