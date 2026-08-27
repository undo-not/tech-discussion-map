import { parseTranscriptUtterance, type TranscriptUtterance } from '../../domain/transcription/utterance.ts';

const databaseName = 'techmap-live-local';
const storeName = 'transcripts';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('local-transcript-store-unavailable'));
  });
}

export async function saveFinalTranscript(utterance: TranscriptUtterance): Promise<void> {
  if (utterance.phase !== 'final') return;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(parseTranscriptUtterance(utterance));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('local-transcript-save-failed'));
      transaction.onabort = () => reject(new Error('local-transcript-save-aborted'));
    });
  } finally {
    database.close();
  }
}

export async function deleteAllLocalTranscripts(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('local-transcript-delete-failed'));
    request.onblocked = () => reject(new Error('local-transcript-delete-blocked'));
  });
}

export const localTranscriptStorageDescription = 'このブラウザープロファイルのIndexedDB（Git作業ツリー外）';
