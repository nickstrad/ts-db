import type { Diagnostic, Group, Id } from "./model";
export const MAX_GROUP_DEPTH = 32;
/** Groups are visual containment only; model identities and view membership remain unchanged. */
export function validateGroups(
  groups: readonly Group[],
  visibleIds: readonly Id[],
  path = "$.groups",
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, suffix: string, message: string) =>
    diagnostics.push({ code, path: path + suffix, severity: "error", message });
  const byId = new Map<Id, Group>();
  const visible = new Set(visibleIds);
  const assigned = new Set<Id>();
  groups.forEach((group, i) => {
    if (byId.has(group.id)) error("duplicate-group-id", `[${i}].id`, `Duplicate group ID "${group.id}".`);
    else byId.set(group.id, group);
    group.memberIds.forEach((id, j) => {
      if (!visible.has(id)) {
        error(
          "group-member-not-visible",
          `[${i}].memberIds[${j}]`,
          `Group member "${id}" must appear in the diagram.`,
        );
      }
      if (assigned.has(id)) {
        error(
          "duplicate-group-member",
          `[${i}].memberIds[${j}]`,
          `Element "${id}" may belong to only one direct group and cannot occur twice.`,
        );
      }
      assigned.add(id);
    });
  });
  groups.forEach((group, i) => {
    if (group.parentGroupId && !byId.has(group.parentGroupId)) {
      error("missing-group-parent", `[${i}].parentGroupId`, `Unknown parent group "${group.parentGroupId}".`);
    }
    const seen = new Set<Id>();
    let current: Group | undefined = group;
    while (current) {
      if (seen.has(current.id)) {
        error("group-cycle", `[${i}].parentGroupId`, "Group parents must form an acyclic forest.");
        break;
      }
      seen.add(current.id);
      if (seen.size > MAX_GROUP_DEPTH) {
        error("group-depth", `[${i}].parentGroupId`, `Group nesting exceeds ${MAX_GROUP_DEPTH} levels.`);
        break;
      }
      current = current.parentGroupId ? byId.get(current.parentGroupId) : undefined;
    }
  });
  return diagnostics;
}
export function directGroupMembership(groups: readonly Group[]): ReadonlyMap<Id, Id> {
  const assigned = new Map<Id, Id>();
  groups.forEach((group) => group.memberIds.forEach((id) => assigned.set(id, group.id)));
  return assigned;
}
