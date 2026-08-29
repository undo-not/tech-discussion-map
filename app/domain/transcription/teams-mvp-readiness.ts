export const teamsMvpReadinessKeys = [
  'signedInDesktop',
  'captionsVisible',
  'captureAllowed',
] as const;

export type TeamsMvpReadinessKey = (typeof teamsMvpReadinessKeys)[number];

export type TeamsMvpReadiness = Record<TeamsMvpReadinessKey, boolean>;

export const emptyTeamsMvpReadiness: TeamsMvpReadiness = {
  signedInDesktop: false,
  captionsVisible: false,
  captureAllowed: false,
};

export function isTeamsMvpReady(value: TeamsMvpReadiness): boolean {
  return teamsMvpReadinessKeys.every((key) => value[key]);
}

export function setTeamsMvpReadiness(
  value: TeamsMvpReadiness,
  key: TeamsMvpReadinessKey,
  checked: boolean,
): TeamsMvpReadiness {
  return { ...value, [key]: checked };
}
