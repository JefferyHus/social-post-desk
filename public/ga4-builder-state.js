/** Invalidates in-flight previews when the project or form changes. */
export function createPreviewGuard() {
  let generation = 0;
  return {
    begin(projectId) { return { projectId, generation: ++generation }; },
    invalidate() { generation++; },
    current(ticket, projectId) { return ticket.projectId === projectId && ticket.generation === generation; },
  };
}
