import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emptyTeamsMvpReadiness,
  isTeamsMvpReady,
  setTeamsMvpReadiness,
  teamsMvpReadinessKeys,
} from '../domain/transcription/teams-mvp-readiness.ts';

test('Teams OCR readiness fails closed until every per-meeting condition is confirmed', () => {
  let readiness = emptyTeamsMvpReadiness;
  assert.equal(isTeamsMvpReady(readiness), false);
  for (const key of teamsMvpReadinessKeys) {
    readiness = setTeamsMvpReadiness(readiness, key, true);
  }
  assert.equal(isTeamsMvpReady(readiness), true);
  assert.equal(isTeamsMvpReady(setTeamsMvpReadiness(readiness, 'captureAllowed', false)), false);
});

test('Teams OCR readiness updates immutably', () => {
  const next = setTeamsMvpReadiness(emptyTeamsMvpReadiness, 'captionsVisible', true);
  assert.notEqual(next, emptyTeamsMvpReadiness);
  assert.equal(emptyTeamsMvpReadiness.captionsVisible, false);
  assert.equal(next.captionsVisible, true);
});
