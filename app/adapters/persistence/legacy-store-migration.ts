const legacyDatabaseName = 'techmap-live-local';

export function purgeLegacyPlaintextTranscripts(factory: IDBFactory = indexedDB): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(legacyDatabaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('legacy-transcript-delete-failed'));
    request.onblocked = () => reject(new Error('legacy-transcript-delete-blocked'));
  });
}

export { legacyDatabaseName };
