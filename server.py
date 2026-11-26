#!/usr/bin/env python3
"""Ór'esař wiki. Zero dependencies (Python 3.9+).
  python3 server.py [serve]            run the app (http://127.0.0.1:8080, PORT env to change)
  python3 server.py import F [--dry-run]   bulk import JSON (same store as the editor)
  python3 server.py export [F]         export entries/relationships/journeys as JSON
  python3 server.py backup [F.zip]     zip of database + all artwork
  python3 server.py restore F.zip      restore a backup (stop the server first)
  python3 server.py purge-demo         delete every record flagged "demo": true
Data lives in ./data (override with WIKI_DATA)."""
import json, os, re, sqlite3, sys, time, zipfile, unicodedata, uuid, io, shutil, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

R = os.path.dirname(os.path.abspath(__file__))
D = os.environ.get('WIKI_DATA', R + '/data'); M = D + '/media'
os.makedirs(M, exist_ok=True)
db = sqlite3.connect(D + '/wiki.db', check_same_thread=False)
db.execute('create table if not exists docs(kind,id,j,primary key(kind,id))')
KEYS = (('entry', 'entries'), ('rel', 'relationships'), ('journey', 'journeys'))
LK = re.compile(r'\[\[([^\]|\\]+)')

def n(s): return re.sub(r"[\u0300-\u036f’'`‘]", "", unicodedata.normalize('NFD', str(s))).lower().strip()
def get(k): return [json.loads(r[0]) for r in db.execute('select j from docs where kind=?', (k,))]
def one(k, i):
    r = db.execute('select j from docs where kind=? and id=?', (k, i)).fetchone(); return r and json.loads(r[0])
def put(k, d):
    d['id'] = d.get('id') or (k[:3] + '-' + uuid.uuid4().hex[:8]); d['updated'] = time.time()
    db.execute('replace into docs values(?,?,?)', (k, d['id'], json.dumps(d, ensure_ascii=False))); db.commit(); return d
def refs(d): return {m.strip() for m in LK.findall(json.dumps(d, ensure_ascii=False))}

def imp(data, dry):
    rep = {'create': 0, 'update': 0, 'errors': [], 'warnings': [], 'dry_run': dry}
    have = {e['id']: e for e in get('entry')}; names = {n(e['title']): e['id'] for e in have.values()}
    inc = {}
    for k, key in KEYS:
        for d in data.get(key, []):
            if not d.get('id'): rep['errors'].append(f'{key}: record without id: {d.get("title") or d}'); continue
            if (k, d['id']) in inc: rep['errors'].append('duplicate id in file: ' + d['id']); continue
            inc[(k, d['id'])] = d
            if k == 'entry':
                t = n(d.get('title', '')); o = names.get(t)
                if o and o != d['id']: rep['warnings'].append(f"possible duplicate: '{d['title']}' ({d['id']}) matches existing {o}")
                names[t] = d['id']
    ids = {i for (k, i) in inc if k == 'entry'} | set(have)
    for (k, i), d in inc.items():
        need = set(refs(d))
        if k == 'rel': need |= {d.get('a'), d.get('b')}
        if k == 'journey':
            for t in d.get('tokens', []):
                need.add(t.get('char')); need |= {s['place'] for s in t.get('stops', []) if s.get('place')}
        for r in need:
            if r not in ids: rep['errors'].append(f'{i}: missing link target {r}')
        rep['update' if one(k, i) else 'create'] += 1
    if not dry and not rep['errors']:
        for (k, i), d in inc.items(): put(k, d)
    elif not dry: rep['warnings'].append('nothing saved because of errors')
    return rep

def export(): return {key: get(k) for k, key in KEYS}
def bak():
    b = io.BytesIO(); db.commit()
    with zipfile.ZipFile(b, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _, fs in os.walk(D):
            for f in fs: p = os.path.join(root, f); z.write(p, os.path.relpath(p, D))
    return b.getvalue()

def apply_map(file, pins):
    cur = one('map', 'current') or {'versions': []}
    if cur.get('file'):
        snap = {e['id']: [e['x'], e['y']] for e in get('entry') if e.get('x') is not None}
        cur['versions'].append({'file': cur['file'], 'pins': snap, 'at': time.time()})
    cur['file'] = file; put('map', {**cur, 'id': 'current'})
    for i, (x, y) in (pins or {}).items():
        e = one('entry', i)
        if e: e['x'], e['y'] = x, y; put('entry', e)

if not one('map', 'current') and os.path.exists(R + '/assets/base-map.jpg'):
    shutil.copy(R + '/assets/base-map.jpg', M + '/base-map.jpg'); put('map', {'id': 'current', 'file': 'base-map.jpg', 'versions': []})

class H(BaseHTTPRequestHandler):
    def log_message(s, *a): pass
    def out(s, b, c=200, t='application/json'):
        if not isinstance(b, bytes): b = json.dumps(b, ensure_ascii=False).encode()
        s.send_response(c); s.send_header('Content-Type', t); s.send_header('Content-Length', str(len(b))); s.end_headers(); s.wfile.write(b)
    def raw(s): return s.rfile.read(int(s.headers.get('Content-Length') or 0))
    def do_GET(s):
        p = urlparse(s.path).path
        if p == '/api/all': return s.out({'entries': get('entry'), 'rels': get('rel'), 'journeys': get('journey'), 'map': one('map', 'current') or {}})
        if p == '/api/export': return s.out(export())
        if p == '/api/backup.zip': return s.out(bak(), 200, 'application/zip')
        if p.startswith('/media/'):
            f = os.path.join(M, os.path.basename(p))
            if os.path.isfile(f): return s.out(open(f, 'rb').read(), 200, mimetypes.guess_type(f)[0] or 'application/octet-stream')
        if p == '/': return s.out(open(R + '/index.html', 'rb').read(), 200, 'text/html; charset=utf-8')
        s.out({'error': 'not found'}, 404)
    def do_POST(s):
        u = urlparse(s.path); q = parse_qs(u.query); p = u.path; b = s.raw()
        try:
            if p.startswith('/api/doc/') and p[9:] in ('entry', 'rel', 'journey'): return s.out(put(p[9:], json.loads(b)))
            if p == '/api/upload':
                ext = os.path.splitext(q.get('name', [''])[0])[1].lower()
                if ext not in ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'): return s.out({'error': 'unsupported image type'}, 400)
                f = uuid.uuid4().hex[:12] + ext; open(M + '/' + f, 'wb').write(b); return s.out({'file': f})
            if p == '/api/map':
                j = json.loads(b); f = os.path.basename(j['file'])
                if not os.path.isfile(M + '/' + f): return s.out({'error': 'unknown file'}, 400)
                apply_map(f, j.get('pins')); return s.out(one('map', 'current'))
            if p == '/api/import': return s.out(imp(json.loads(b), q.get('dry') == ['1']))
        except Exception as e: return s.out({'error': str(e)}, 400)
        s.out({'error': 'not found'}, 404)
    def do_DELETE(s):
        m = re.match(r'/api/doc/(entry|rel|journey)/(.+)', urlparse(s.path).path)
        if not m: return s.out({'error': 'not found'}, 404)
        db.execute('delete from docs where kind=? and id=?', (m[1], m[2])); db.commit(); s.out({'ok': True})

if __name__ == '__main__':
    a = sys.argv[1:] or ['serve']; c = a[0]
    if c == 'serve':
        port = int(os.environ.get('PORT', 8080)); print(f'Ór’esař wiki on http://127.0.0.1:{port}  (data: {D})')
        ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
    elif c == 'import':
        r = imp(json.load(open(a[1], encoding='utf-8')), '--dry-run' in a); print(json.dumps(r, indent=2, ensure_ascii=False)); sys.exit(1 if r['errors'] else 0)
    elif c == 'export':
        t = json.dumps(export(), indent=2, ensure_ascii=False)
        open(a[1], 'w', encoding='utf-8').write(t) if len(a) > 1 else print(t)
    elif c == 'backup':
        f = a[1] if len(a) > 1 else time.strftime('oresar-backup-%Y%m%d-%H%M%S.zip'); open(f, 'wb').write(bak()); print('wrote', f)
    elif c == 'restore':
        db.close(); zipfile.ZipFile(a[1]).extractall(D); print('restored; start the server again')
    elif c == 'purge-demo':
        db.execute("delete from docs where kind!='map' and j like '%\"demo\": true%'"); db.commit(); print('demo records removed')
    else: print(__doc__)
