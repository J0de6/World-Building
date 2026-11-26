// Browser-local edits and artwork are stored separately from the published seed.
const collections = {entry: 'entries', rel: 'relationships', journey: 'journeys'};
const imageExtensions = /\.(jpe?g|png|webp|gif|svg)$/i;

export async function loadArchive() {
  const response = await fetch('./archive.json');
  if (!response.ok) throw new Error(`Archive data returned HTTP ${response.status}`);
  const data = await response.json();
  if (!data || !Object.values(collections).every(key =>
    Array.isArray(data[key]) && data[key].every(record => typeof record?.id === 'string')
  ) || typeof data.map?.file !== 'string' || !Array.isArray(data.map.versions)) {
    throw new Error('Invalid archive data');
  }
  return data;
}

export async function openArchive(seed) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(`oresar-archive:${new URL('.', location.href).pathname}`, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('state');
      request.result.createObjectStore('artwork');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const urls = new Map();

  function transaction(mode, run) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'artwork'], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Archive transaction failed'));
      run(tx, value => { result = value; });
    });
  }

  const data = await transaction('readonly', (tx, finish) => {
    const state = tx.objectStore('state').get('archive');
    state.onsuccess = () => finish(state.result ?? seed);
    const artwork = tx.objectStore('artwork').openCursor();
    artwork.onsuccess = () => {
      const cursor = artwork.result;
      if (!cursor) return;
      urls.set(cursor.key, URL.createObjectURL(cursor.value));
      cursor.continue();
    };
  });

  function update(change, files = []) {
    return transaction('readwrite', (tx, finish) => {
      const store = tx.objectStore('state');
      const request = store.get('archive');
      request.onsuccess = () => {
        const state = request.result ?? structuredClone(seed);
        const record = change(state);
        for (const [id, file] of files) tx.objectStore('artwork').put(file, id);
        store.put(state, 'archive');
        finish({state, record});
      };
    });
  }

  function put(state, kind, record) {
    const key = collections[kind];
    const saved = {...record, id: record.id || crypto.randomUUID()};
    state[key] = [...state[key].filter(item => item.id !== saved.id), saved];
    return saved;
  }

  function imageFor(file) {
    if (!imageExtensions.test(file.name)) throw new Error('Choose a JPEG, PNG, WebP, GIF or SVG image.');
    return {id: crypto.randomUUID(), file};
  }

  async function saveArtwork(files, change) {
    const result = await update(change, files);
    for (const [id, file] of files) urls.set(id, URL.createObjectURL(file));
    return result;
  }

  function applyMap(state, file, pins, restore) {
    const currentPins = Object.fromEntries(state.entries.filter(entry => entry.x != null)
      .map(entry => [entry.id, [entry.x, entry.y]]));
    state.map.versions.push({file: state.map.file, pins: currentPins, at: Date.now() / 1000});
    state.map.file = file;
    for (const entry of state.entries) {
      if (Object.hasOwn(pins, entry.id)) [entry.x, entry.y] = pins[entry.id];
      else if (restore) { delete entry.x; delete entry.y; }
    }
  }

  return {
    data,
    mediaUrl: file => urls.get(file) || './assets/' + encodeURIComponent(file),
    save: (kind, record) => update(state => put(state, kind, record)),
    remove: (kind, id) => update(state => {
      const key = collections[kind];
      state[key] = state[key].filter(record => record.id !== id);
    }),
    saveEntry: (entry, files) => saveArtwork(files, state => put(state, 'entry', entry)),
    imageFor,
    replaceMap: (file, pins) => {
      const image = imageFor(file);
      return saveArtwork([[image.id, file]], state => applyMap(state, image.id, pins, false));
    },
    restoreMap: version => update(state => applyMap(state, version.file, version.pins, true)),
    publishJourney: (journey, event) => update(state => {
      put(state, 'entry', event);
      put(state, 'journey', {...journey, status: 'canon'});
    })
  };
}
