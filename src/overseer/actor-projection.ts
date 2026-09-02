export type ProjectedActor =
  | { kind: "member"; label: string }
  | { kind: "agent"; label: string; model: string }
  | { kind: "github"; login: string };

/** Public projections accept display facts only. Internal identity cannot cross this seam. */
export function projectAgent(name: string, model: string): ProjectedActor {
  return { kind: "agent", label: name, model };
}

export function projectMember(isViewer: boolean): ProjectedActor {
  return { kind: "member", label: isViewer ? "You" : "Member" };
}

export function projectGithub(login: string | null): ProjectedActor {
  return { kind: "github", login: login?.trim() || "ghost" };
}
