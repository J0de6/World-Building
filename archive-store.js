// The published seed and browser-only changes have separate lifecycles.
const collections = {entry: 'entries', rel: 'relationships', journey: 'journeys'};
const imageExtensions = /\.(jpe?g|png|webp|gif|svg)$/i;
const overridesKey = 'overrides';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function loadArchive() {
  try {
    const response = await fetch('./archive.json', {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json().catch(() => { throw new Error('Expected JSON data'); });
    if (!data || !Object.values(collections).every(key =>
      Array.isArray(data[key]) && data[key].every(record => typeof record?.id === 'string')
    ) || typeof data.map?.file !== 'string' || !Array.isArray(data.map.versions)) {
      throw new Error('Unexpected archive structure');
    }
    return data;
  } catch (error) {
    throw new Error(`Could not load archive.json: ${error.message}`);
  }
}

// Arrays are edited as a unit. Archive collections have their own stable ID keys.
function difference(before, after) {
  if (isObject(before) && isObject(after)) {
    const fields = new Map();
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const change = difference(Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(after, key) ? after[key] : undefined);
      if (change) fields.set(key, change);
    }
    return fields.size ? {fields} : undefined;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  return after === undefined ? {remove: true} : {value: after};
}

function overlay(base, patch) {
  if (!patch) return base;
  if (patch.remove) return undefined;
  if (!patch.fields) return patch.value;
  const fields = new Map(Object.entries(isObject(base) ? base : {}));
  for (const [key, change] of patch.fields) {
    if (change.remove) fields.delete(key);
    else fields.set(key, overlay(fields.get(key), change));
  }
  return Object.fromEntries(fields);
}

// Add the effects of this edit without discarding earlier overrides of other fields.
function combine(previous, change) {
  if (!previous || !change.fields) return change;
  if (!previous.fields) return {value: overlay(previous.value, change)};
  const fields = new Map(previous.fields);
  for (const [key, value] of change.fields) fields.set(key, combine(fields.get(key), value));
  return {fields};
}

function rebase(seed, overrides) {
  const data = {...seed, map: overlay(seed.map, overrides.map)};
  for (const key of Object.values(collections)) {
    const rows = new Map(seed[key].map(record => [record.id, record]));
    for (const [id, {patch, fallback}] of overrides[key] ?? []) {
      if (patch.remove) rows.delete(id);
      else rows.set(id, rows.has(id) ? overlay(rows.get(id), patch) : fallback);
    }
    data[key] = [...rows.values()];
  }
  return data;
}

function recordChanges(overrides, before, after) {
  for (const key of Object.values(collections)) {
    const prior = new Map(before[key].map(record => [record.id, record]));
    const next = new Map(after[key].map(record => [record.id, record]));
    const changes = overrides[key] ?? new Map();
    for (const id of new Set([...prior.keys(), ...next.keys()])) {
      const fallback = next.get(id);
      const change = difference(prior.get(id), fallback);
      if (change) changes.set(id, {patch: combine(changes.get(id)?.patch, change), fallback});
    }
    if (changes.size) overrides[key] = changes;
  }
  const mapChange = difference(before.map, after.map);
  if (mapChange) overrides.map = combine(overrides.map, mapChange);
  return overrides;
}

async function legacySeed() {
  // The first static release seeded the whole local snapshot from this demo.
  const response = await fetch('./demo/demo.json', {cache: 'no-cache'});
  if (!response.ok) throw new Error('Could not load the original archive seed for browser storage migration.');
  const demo = await response.json();
  return {
    ...demo,
    journeys: demo.journeys.map(record => record.id === 'jr-demo' ? {...record, status: 'draft'} : record),
    map: {file: 'base-map.jpg', versions: []}
  };
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

  let overrides = await transaction('readonly', (tx, finish) => {
    const state = tx.objectStore('state').get(overridesKey);
    state.onsuccess = () => finish(state.result);
    const artwork = tx.objectStore('artwork').openCursor();
    artwork.onsuccess = () => {
      const cursor = artwork.result;
      if (!cursor) return;
      urls.set(cursor.key, URL.createObjectURL(cursor.value));
      cursor.continue();
    };
  });
  if (!overrides) {
    const readLegacy = (tx, finish) => {
      const request = tx.objectStore('state').get('archive');
      request.onsuccess = () => finish(request.result);
    };
    if (await transaction('readonly', readLegacy)) {
      const baseline = await legacySeed();
      overrides = await transaction('readwrite', (tx, finish) => {
        const store = tx.objectStore('state');
        const stored = store.get(overridesKey);
        stored.onsuccess = () => {
          if (stored.result) return finish(stored.result);
          readLegacy(tx, snapshot => {
            const bundled = baseline.journeys.find(record => record.id === 'jr-demo');
            const localDemo = snapshot.journeys.find(record => record.id === 'jr-demo');
            // A changed copy of the example can be a real draft in this browser.
            if (bundled && localDemo?.status === 'draft' && difference(bundled, localDemo)) {
              bundled.status = 'sample';
            }
            const migrated = recordChanges({}, baseline, snapshot);
            store.put(migrated, overridesKey);
            finish(migrated);
          });
        };
      });
    }
  }

  function update(change, files = []) {
    return transaction('readwrite', (tx, finish) => {
      const store = tx.objectStore('state');
      const request = store.get(overridesKey);
      request.onsuccess = () => {
        const local = request.result ?? {};
        const before = rebase(seed, local);
        const state = structuredClone(before);
        const record = change(state);
        for (const [id, file] of files) tx.objectStore('artwork').put(file, id);
        store.put(recordChanges(local, before, state), overridesKey);
        finish({state, record});
      };
    });
  }

  function put(state, kind, record) {
    const key = collections[kind];
    const saved = {...record, id: record.id || crypto.randomUUID()};
    const index = state[key].findIndex(item => item.id === saved.id);
    if (index < 0) state[key].push(saved);
    else state[key][index] = saved;
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

  function applyMap(state, file, pins, version) {
    const currentPins = Object.fromEntries(state.entries.filter(entry => entry.x != null)
      .map(entry => [entry.id, [entry.x, entry.y]]));
    const unplaced = state.entries.filter(entry => entry.x == null).map(entry => entry.id);
    state.map.versions.push({file: state.map.file, pins: currentPins, unplaced, at: Date.now() / 1000});
    state.map.file = file;
    const clearPins = version && new Set(version.unplaced);
    for (const entry of state.entries) {
      if (Object.hasOwn(pins, entry.id)) [entry.x, entry.y] = pins[entry.id];
      else if (version && (!version.unplaced || clearPins.has(entry.id))) { delete entry.x; delete entry.y; }
    }
  }

  return {
    data: rebase(seed, overrides ?? {}),
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
      return saveArtwork([[image.id, file]], state => applyMap(state, image.id, pins));
    },
    restoreMap: version => update(state => applyMap(state, version.file, version.pins, version)),
    publishJourney: (journey, event) => update(state => {
      put(state, 'entry', event);
      put(state, 'journey', {...journey, status: 'canon'});
    })
  };
}
