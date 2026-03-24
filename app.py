import os
import re
import json
import sqlite3
import hashlib
import secrets
import subprocess
import tempfile
from pathlib import Path
from functools import wraps
from datetime import datetime

from flask import (
    Flask, render_template, request, jsonify, session,
    redirect, url_for, send_file, abort, g, Response
)
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import bcrypt

VERSION = '0.1.1'

app = Flask(__name__)
app.secret_key = os.environ.get('COURSEVIEW_SECRET', secrets.token_hex(32))
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=False,
    PERMANENT_SESSION_LIFETIME=86400 * 7,
)

COURSES_DIR = Path(os.environ.get('COURSEVIEW_COURSES_DIR', '/app/courses'))
DATA_DIR = Path(os.environ.get('COURSEVIEW_DATA_DIR', '/app/data'))
DB_PATH = DATA_DIR / 'courseview.db'

VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'}
DOCUMENT_EXTENSIONS = {'.pdf', '.md', '.txt'}
SUBTITLE_EXTENSIONS = {'.srt', '.vtt'}

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    storage_uri=f"memory://",
    default_limits=[]
)


def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(str(DB_PATH))
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DB_PATH))
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS progress (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            course_path TEXT NOT NULL,
            lesson_path TEXT NOT NULL,
            position REAL DEFAULT 0,
            duration REAL DEFAULT 0,
            completed INTEGER DEFAULT 0,
            last_watched TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, course_path, lesson_path)
        );
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            course_path TEXT NOT NULL,
            lesson_path TEXT NOT NULL,
            timestamp REAL DEFAULT 0,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id);
        CREATE INDEX IF NOT EXISTS idx_progress_last ON progress(user_id, last_watched);
        CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id);
        CREATE INDEX IF NOT EXISTS idx_notes_lesson ON notes(user_id, course_path, lesson_path);
        CREATE TABLE IF NOT EXISTS course_libraries (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            label TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, path)
        );
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, key)
        );
        CREATE TABLE IF NOT EXISTS course_tags (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            course_path TEXT NOT NULL,
            tag_type TEXT NOT NULL CHECK(tag_type IN ('source', 'category')),
            tag_value TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, course_path, tag_type, tag_value)
        );
        CREATE INDEX IF NOT EXISTS idx_course_tags_user ON course_tags(user_id, tag_type);
        CREATE TABLE IF NOT EXISTS lesson_order (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            course_path TEXT NOT NULL,
            ordered_paths TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, course_path)
        );
    ''')

    env_user = os.environ.get('COURSEVIEW_USER')
    env_pass = os.environ.get('COURSEVIEW_PASS')
    if env_user and env_pass:
        existing = db.execute('SELECT id FROM users WHERE username = ?', (env_user,)).fetchone()
        if not existing:
            hashed = bcrypt.hashpw(env_pass.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
            db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', (env_user, hashed))
            db.commit()

    db.close()


def needs_setup():
    db = get_db()
    return db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if needs_setup():
            return redirect(url_for('setup'))
        if 'user_id' not in session:
            if request.is_json or request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def generate_csrf_token():
    if '_csrf_token' not in session:
        session['_csrf_token'] = secrets.token_hex(32)
    return session['_csrf_token']


def validate_csrf():
    token = request.form.get('_csrf_token') or request.headers.get('X-CSRF-Token')
    if not token or token != session.get('_csrf_token'):
        abort(403, 'CSRF validation failed')


app.jinja_env.globals['csrf_token'] = generate_csrf_token


# --- Auth Routes ---

@app.route('/setup', methods=['GET', 'POST'])
@limiter.limit("5 per minute", methods=["POST"])
def setup():
    if not needs_setup():
        return redirect(url_for('login'))

    if request.method == 'POST':
        validate_csrf()
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        confirm = request.form.get('confirm', '')

        if not username or len(username) < 2:
            return render_template('setup.html', error='Username must be at least 2 characters')
        if not password or len(password) < 4:
            return render_template('setup.html', error='Password must be at least 4 characters')
        if password != confirm:
            return render_template('setup.html', error='Passwords do not match')

        db = get_db()
        hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', (username, hashed))
        db.commit()

        user = db.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
        session.permanent = True
        session['user_id'] = user['id']
        session['username'] = user['username']
        return redirect(url_for('dashboard'))

    return render_template('setup.html')


@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("5 per minute", methods=["POST"])
def login():
    if needs_setup():
        return redirect(url_for('setup'))
    if 'user_id' in session:
        return redirect(url_for('dashboard'))

    if request.method == 'POST':
        validate_csrf()
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        db = get_db()
        user = db.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()

        if user and bcrypt.checkpw(password.encode('utf-8'), user['password_hash'].encode('utf-8')):
            session.permanent = True
            session['user_id'] = user['id']
            session['username'] = user['username']
            return redirect(url_for('dashboard'))

        return render_template('login.html', error='Invalid credentials')

    return render_template('login.html')


@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('login'))


# --- Helpers ---

def natural_sort_key(s):
    return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', str(s))]


def get_library_paths(user_id=None):
    """Get course library paths. Falls back to COURSES_DIR if none configured."""
    if user_id:
        db = get_db()
        rows = db.execute('SELECT path FROM course_libraries WHERE user_id = ?', (user_id,)).fetchall()
        if rows:
            return [Path(r['path']) for r in rows]
    return [COURSES_DIR]


def scan_courses(user_id=None):
    courses = []
    lib_paths = get_library_paths(user_id)

    for lib_path in lib_paths:
        if not lib_path.exists():
            continue
        # Scan 3 levels deep: Category > Provider > Course
        for cat_entry in sorted(lib_path.iterdir(), key=lambda x: natural_sort_key(x.name)):
            if not cat_entry.is_dir() or cat_entry.name.startswith('.'):
                continue
            # Check if this is a flat structure (files directly in subdirs = old style)
            # If cat_entry contains media files or its children do directly, treat as old-style
            has_media = any(
                f.suffix.lower() in VIDEO_EXTENSIONS | DOCUMENT_EXTENSIONS
                for f in cat_entry.iterdir() if f.is_file()
            )
            if has_media:
                # Old-style: direct subfolder is a course
                course = scan_course(cat_entry, lib_path, category='', provider='')
                if course['lessons']:
                    courses.append(course)
                continue

            for prov_entry in sorted(cat_entry.iterdir(), key=lambda x: natural_sort_key(x.name)):
                if not prov_entry.is_dir() or prov_entry.name.startswith('.'):
                    continue
                # Check if provider dir has media directly (2-level structure)
                has_media = any(
                    f.suffix.lower() in VIDEO_EXTENSIONS | DOCUMENT_EXTENSIONS
                    for f in prov_entry.iterdir() if f.is_file()
                )
                if has_media:
                    course = scan_course(prov_entry, lib_path,
                                         category=format_name(cat_entry.name), provider='')
                    if course['lessons']:
                        courses.append(course)
                    continue

                for course_entry in sorted(prov_entry.iterdir(), key=lambda x: natural_sort_key(x.name)):
                    if not course_entry.is_dir() or course_entry.name.startswith('.'):
                        continue
                    course = scan_course(course_entry, lib_path,
                                         category=format_name(cat_entry.name),
                                         provider=format_name(prov_entry.name))
                    if course['lessons']:
                        courses.append(course)

    courses.sort(key=lambda x: natural_sort_key(x['name']))
    return courses


def scan_course(course_dir, base_dir, category='', provider=''):
    rel_path = str(course_dir.relative_to(base_dir))
    tree = _scan_tree(course_dir, course_dir, base_dir)
    lessons = _flatten_tree(tree)

    return {
        'path': rel_path,
        'name': format_name(course_dir.name),
        'lessons': lessons,
        'tree': tree,
        'library': str(base_dir),
        'category': category,
        'provider': provider,
    }


def _scan_tree(base_dir, current_dir, lib_dir):
    """Build a recursive tree of sections and lessons."""
    children = []
    for entry in sorted(current_dir.iterdir(), key=lambda x: natural_sort_key(x.name)):
        if entry.is_dir() and not entry.name.startswith('.'):
            subtree = _scan_tree(base_dir, entry, lib_dir)
            if subtree:  # Only include sections that have content
                section_id = str(entry.relative_to(base_dir))
                children.append({
                    'type': 'section',
                    'id': section_id,
                    'name': format_name(entry.name),
                    'children': subtree,
                })
        elif entry.is_file():
            suffix = entry.suffix.lower()
            if suffix in VIDEO_EXTENSIONS:
                rel = str(entry.relative_to(base_dir))
                subtitles = find_subtitles(entry, lib_dir)
                children.append({
                    'type': 'lesson',
                    'path': rel,
                    'name': format_name(entry.stem),
                    'subtitles': subtitles,
                    'lessonType': 'video',
                })
            elif suffix in DOCUMENT_EXTENSIONS:
                rel = str(entry.relative_to(base_dir))
                fmt = {'.pdf': 'pdf', '.md': 'markdown', '.txt': 'text'}[suffix]
                children.append({
                    'type': 'lesson',
                    'path': rel,
                    'name': format_name(entry.stem),
                    'subtitles': [],
                    'lessonType': 'document',
                    'format': fmt,
                })
    return children


def _flatten_tree(tree):
    """Depth-first flatten of tree into ordered lesson list."""
    lessons = []
    for node in tree:
        if node['type'] == 'section':
            lessons.extend(_flatten_tree(node['children']))
        else:
            lessons.append(node)
    return lessons


def find_subtitles(video_path, lib_dir):
    subs = []
    stem = video_path.stem
    parent = video_path.parent
    for ext in SUBTITLE_EXTENSIONS:
        sub = parent / f"{stem}{ext}"
        if sub.exists():
            subs.append({'path': str(sub.relative_to(lib_dir)), 'ext': ext})
        for f in parent.glob(f"{stem}.*{ext}"):
            lang = f.stem.split('.')[-1] if '.' in f.stem else 'default'
            rel = str(f.relative_to(lib_dir))
            if not any(s['path'] == rel for s in subs):
                subs.append({'path': rel, 'ext': ext, 'lang': lang})
    return subs


def _add_tree_progress(tree, progress_set):
    """Recursively add completed/total counts to section nodes."""
    for node in tree:
        if node['type'] == 'section':
            _add_tree_progress(node['children'], progress_set)
            total = _count_lessons(node['children'])
            completed = _count_completed(node['children'], progress_set)
            node['total'] = total
            node['completed'] = completed
        # lessons don't need counts


def _count_lessons(tree):
    count = 0
    for node in tree:
        if node['type'] == 'section':
            count += _count_lessons(node['children'])
        else:
            count += 1
    return count


def _count_completed(tree, progress_set):
    count = 0
    for node in tree:
        if node['type'] == 'section':
            count += _count_completed(node['children'], progress_set)
        elif node['path'] in progress_set:
            count += 1
    return count


def _apply_tree_order(tree, order_data):
    """Apply saved ordering to tree in-place. order_data has section_order and lesson_orders."""
    section_order = order_data.get('section_order', {})
    lesson_orders = order_data.get('lesson_orders', {})

    def reorder_children(children, parent_id):
        sections = [c for c in children if c['type'] == 'section']
        lessons = [c for c in children if c['type'] == 'lesson']

        # Reorder sections if we have an order for this parent
        if parent_id in section_order:
            order = section_order[parent_id]
            sec_by_name = {}
            for s in sections:
                # Use the folder name (last part of id) for matching
                sec_by_name[s['id'].split('/')[-1] if '/' in s['id'] else s['id']] = s
            ordered_secs = []
            for name in order:
                if name in sec_by_name:
                    ordered_secs.append(sec_by_name.pop(name))
            # Append any new sections not in saved order
            ordered_secs.extend(sec_by_name.values())
            sections = ordered_secs

        # Reorder lessons if we have an order for this parent
        if parent_id in lesson_orders:
            order = lesson_orders[parent_id]
            les_by_path = {l['path']: l for l in lessons}
            ordered_les = []
            for path in order:
                if path in les_by_path:
                    ordered_les.append(les_by_path.pop(path))
            ordered_les.extend(les_by_path.values())
            lessons = ordered_les

        # Recurse into sections
        for sec in sections:
            reorder_children(sec['children'], sec['id'])

        # Rebuild children: sections first, then lessons (or interleaved based on original)
        children.clear()
        children.extend(sections)
        children.extend(lessons)

    reorder_children(tree, '')


def format_name(name):
    name = re.sub(r'^\d+[\s._-]*', '', name)
    name = name.replace('_', ' ').replace('-', ' ')
    name = re.sub(r'\s+', ' ', name).strip()
    return name if name else 'Untitled'


def safe_path(base, user_path):
    resolved = (base / user_path).resolve()
    if not str(resolved).startswith(str(base.resolve())):
        abort(403)
    return resolved


def resolve_file_in_libraries(filepath, user_id, allowed_extensions):
    """Find a file across all configured library paths."""
    for lib_path in get_library_paths(user_id):
        full = safe_path(lib_path, filepath)
        if full.exists() and full.suffix.lower() in allowed_extensions:
            return full
    abort(404)


# --- API Routes ---

@app.route('/')
@login_required
def dashboard():
    return render_template('index.html', version=VERSION)


@app.route('/api/courses')
@login_required
def api_courses():
    courses = scan_courses(session['user_id'])
    db = get_db()
    user_id = session['user_id']

    # Fetch all tags for user in one query
    all_tags = db.execute(
        'SELECT id, course_path, tag_type, tag_value FROM course_tags WHERE user_id = ?',
        (user_id,)
    ).fetchall()

    tags_by_course = {}
    for t in all_tags:
        cp = t['course_path']
        if cp not in tags_by_course:
            tags_by_course[cp] = {'sources': [], 'categories': []}
        if t['tag_type'] == 'source':
            tags_by_course[cp]['sources'].append(t['tag_value'])
        else:
            tags_by_course[cp]['categories'].append(t['tag_value'])

    # Fetch all custom lesson orders
    all_orders = db.execute(
        'SELECT course_path, ordered_paths FROM lesson_order WHERE user_id = ?',
        (user_id,)
    ).fetchall()
    orders_by_course = {r['course_path']: json.loads(r['ordered_paths']) for r in all_orders}

    for course in courses:
        # Apply custom lesson order if exists
        if course['path'] in orders_by_course:
            saved = orders_by_course[course['path']]
            if isinstance(saved, dict):
                # New structured format
                _apply_tree_order(course['tree'], saved)
                course['lessons'] = _flatten_tree(course['tree'])
            elif isinstance(saved, list):
                # Legacy flat format - reorder flat lessons
                lessons_by_path = {l['path']: l for l in course['lessons']}
                ordered = [lessons_by_path[p] for p in saved if p in lessons_by_path]
                ordered_set = set(saved)
                for l in course['lessons']:
                    if l['path'] not in ordered_set:
                        ordered.append(l)
                course['lessons'] = ordered
            course['custom_order'] = True
        else:
            course['custom_order'] = False

        total = len(course['lessons'])
        if total == 0:
            course['progress'] = 0
        else:
            completed_rows = db.execute(
                'SELECT lesson_path FROM progress WHERE user_id = ? AND course_path = ? AND completed = 1',
                (user_id, course['path'])
            ).fetchall()
            progress_set = {r['lesson_path'] for r in completed_rows}
            course['progress'] = round((len(progress_set) / total) * 100)
            # Add progress counts to tree sections
            _add_tree_progress(course['tree'], progress_set)
        course['tags'] = tags_by_course.get(course['path'], {'sources': [], 'categories': []})

    return jsonify(courses)


@app.route('/api/continue')
@login_required
def api_continue():
    db = get_db()
    user_id = session['user_id']
    # Get most recently watched course (one entry per course, no duplicates)
    rows = db.execute('''
        SELECT p.course_path, p.lesson_path, p.position, p.duration, p.last_watched
        FROM progress p
        INNER JOIN (
            SELECT course_path, MAX(last_watched) as max_watched
            FROM progress
            WHERE user_id = ?
            GROUP BY course_path
        ) latest ON p.course_path = latest.course_path AND p.last_watched = latest.max_watched
        WHERE p.user_id = ?
        ORDER BY p.last_watched DESC
        LIMIT 6
    ''', (user_id, user_id)).fetchall()

    results = []
    for row in rows:
        course_name = format_name(Path(row['course_path']).name)
        results.append({
            'course_path': row['course_path'],
            'lesson_path': row['lesson_path'],
            'course_name': course_name,
            'lesson_name': format_name(Path(row['lesson_path']).stem),
            'position': row['position'],
            'duration': row['duration'],
            'last_watched': row['last_watched'],
        })
    return jsonify(results)


@app.route('/api/progress/<path:course_path>')
@login_required
def api_course_progress(course_path):
    db = get_db()
    user_id = session['user_id']
    rows = db.execute(
        'SELECT lesson_path, position, duration, completed FROM progress WHERE user_id = ? AND course_path = ?',
        (user_id, course_path)
    ).fetchall()
    return jsonify({r['lesson_path']: dict(r) for r in rows})


@app.route('/api/progress', methods=['POST'])
@login_required
def api_update_progress():
    validate_csrf()
    data = request.json
    db = get_db()
    user_id = session['user_id']

    course_path = data['course_path']
    lesson_path = data['lesson_path']
    position = data.get('position', 0)
    duration = data.get('duration', 0)
    completed = data.get('completed', False)

    db.execute('''
        INSERT INTO progress (user_id, course_path, lesson_path, position, duration, completed, last_watched)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, course_path, lesson_path) DO UPDATE SET
            position = excluded.position,
            duration = excluded.duration,
            completed = excluded.completed,
            last_watched = CURRENT_TIMESTAMP
    ''', (user_id, course_path, lesson_path, position, duration, 1 if completed else 0))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/notes/<path:course_path>/<path:lesson_path>')
@login_required
def api_get_notes(course_path, lesson_path):
    db = get_db()
    user_id = session['user_id']
    rows = db.execute(
        'SELECT id, timestamp, content, created_at FROM notes WHERE user_id = ? AND course_path = ? AND lesson_path = ? ORDER BY timestamp',
        (user_id, course_path, lesson_path)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/notes', methods=['POST'])
@login_required
def api_create_note():
    validate_csrf()
    data = request.json
    db = get_db()
    user_id = session['user_id']

    db.execute(
        'INSERT INTO notes (user_id, course_path, lesson_path, timestamp, content) VALUES (?, ?, ?, ?, ?)',
        (user_id, data['course_path'], data['lesson_path'], data.get('timestamp', 0), data['content'])
    )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/notes/<int:note_id>', methods=['DELETE'])
@login_required
def api_delete_note(note_id):
    validate_csrf()
    db = get_db()
    user_id = session['user_id']
    db.execute('DELETE FROM notes WHERE id = ? AND user_id = ?', (note_id, user_id))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/search')
@login_required
def api_search():
    q = request.args.get('q', '').strip().lower()
    if not q or len(q) < 2:
        return jsonify([])

    results = []
    courses = scan_courses(session['user_id'])
    for course in courses:
        if q in course['name'].lower():
            results.append({'type': 'course', 'course_path': course['path'], 'name': course['name']})
        for lesson in course['lessons']:
            if q in lesson['name'].lower():
                results.append({
                    'type': 'lesson',
                    'course_path': course['path'],
                    'lesson_path': lesson['path'],
                    'course_name': course['name'],
                    'name': lesson['name'],
                })

    db = get_db()
    user_id = session['user_id']
    note_rows = db.execute(
        "SELECT id, course_path, lesson_path, timestamp, content FROM notes WHERE user_id = ? AND LOWER(content) LIKE ?",
        (user_id, f'%{q}%')
    ).fetchall()
    for row in note_rows:
        results.append({
            'type': 'note',
            'course_path': row['course_path'],
            'lesson_path': row['lesson_path'],
            'content': row['content'],
            'timestamp': row['timestamp'],
        })

    return jsonify(results[:50])


@app.route('/video/preview-transcode/<path:filepath>')
@login_required
def serve_transcode_preview(filepath):
    """Serve the .transcoded.mp4 version of a file for quality verification."""
    video_path = resolve_file_in_libraries(filepath, session['user_id'], VIDEO_EXTENSIONS)
    transcoded_path = video_path.with_suffix('.transcoded.mp4')
    if not transcoded_path.exists():
        abort(404)
    return send_file(transcoded_path)


@app.route('/video/<path:filepath>')
@login_required
def serve_video(filepath):
    video_path = resolve_file_in_libraries(filepath, session['user_id'], VIDEO_EXTENSIONS)

    file_size = video_path.stat().st_size
    range_header = request.headers.get('Range')

    if range_header:
        byte_start = 0
        byte_end = file_size - 1

        match = re.match(r'bytes=(\d+)-(\d*)', range_header)
        if match:
            byte_start = int(match.group(1))
            if match.group(2):
                byte_end = int(match.group(2))

        content_length = byte_end - byte_start + 1
        mime = _get_mime(video_path)

        def generate():
            with open(video_path, 'rb') as f:
                f.seek(byte_start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    data = f.read(chunk_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        response = app.response_class(generate(), status=206, mimetype=mime)
        response.headers['Content-Range'] = f'bytes {byte_start}-{byte_end}/{file_size}'
        response.headers['Accept-Ranges'] = 'bytes'
        response.headers['Content-Length'] = content_length
        return response

    return send_file(video_path)


@app.route('/subtitle/<path:filepath>')
@login_required
def serve_subtitle(filepath):
    sub_path = resolve_file_in_libraries(filepath, session['user_id'], SUBTITLE_EXTENSIONS)

    mime = 'text/vtt' if sub_path.suffix.lower() == '.vtt' else 'application/x-subrip'
    return send_file(sub_path, mimetype=mime)


@app.route('/document/<path:filepath>')
@login_required
def serve_document(filepath):
    doc_path = resolve_file_in_libraries(filepath, session['user_id'], DOCUMENT_EXTENSIONS)

    if doc_path.suffix.lower() == '.pdf':
        return send_file(doc_path, mimetype='application/pdf')

    content = doc_path.read_text(encoding='utf-8', errors='replace')
    return jsonify({'content': content})


# --- Settings & Libraries Routes ---

@app.route('/api/settings')
@login_required
def api_get_settings():
    db = get_db()
    user_id = session['user_id']

    rows = db.execute('SELECT key, value FROM settings WHERE user_id = ?', (user_id,)).fetchall()
    settings = {r['key']: r['value'] for r in rows}

    libs = db.execute(
        'SELECT id, path, label, created_at FROM course_libraries WHERE user_id = ? ORDER BY created_at',
        (user_id,)
    ).fetchall()

    user = db.execute('SELECT username FROM users WHERE id = ?', (user_id,)).fetchone()

    return jsonify({
        'settings': settings,
        'libraries': [dict(r) for r in libs],
        'username': user['username'],
    })


@app.route('/api/settings', methods=['PUT'])
@login_required
def api_update_settings():
    validate_csrf()
    data = request.json
    db = get_db()
    user_id = session['user_id']

    allowed_keys = {'playback_speed', 'auto_advance', 'theme', 'ui_density'}
    for key, value in data.items():
        if key in allowed_keys:
            db.execute('''
                INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
                ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
            ''', (user_id, key, str(value)))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/libraries', methods=['POST'])
@login_required
def api_add_library():
    validate_csrf()
    data = request.json
    db = get_db()
    user_id = session['user_id']

    path = data.get('path', '').strip()
    label = data.get('label', '').strip()

    if not path:
        return jsonify({'error': 'Path is required'}), 400

    lib_path = Path(path)
    if not lib_path.is_dir():
        return jsonify({'error': 'Path does not exist or is not a directory'}), 400

    if not label:
        label = lib_path.name

    try:
        db.execute(
            'INSERT INTO course_libraries (user_id, path, label) VALUES (?, ?, ?)',
            (user_id, str(lib_path), label)
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({'error': 'This path is already added'}), 409

    return jsonify({'ok': True})


@app.route('/api/libraries/<int:lib_id>', methods=['DELETE'])
@login_required
def api_delete_library(lib_id):
    validate_csrf()
    db = get_db()
    user_id = session['user_id']
    db.execute('DELETE FROM course_libraries WHERE id = ? AND user_id = ?', (lib_id, user_id))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/browse')
@login_required
def api_browse():
    """Browse directories within library paths for adding courses."""
    path = request.args.get('path', '')
    user_id = session['user_id']
    lib_paths = get_library_paths(user_id)

    if not path:
        dirs = []
        for lp in lib_paths:
            if lp.exists():
                dirs.append({
                    'name': lp.name,
                    'path': str(lp),
                    'is_root': True,
                })
        return jsonify(dirs)

    target = Path(path).resolve()
    allowed = any(str(target).startswith(str(lp.resolve())) for lp in lib_paths)

    if not allowed or not target.is_dir():
        return jsonify({'error': 'Invalid path'}), 400

    dirs = []
    for entry in sorted(target.iterdir(), key=lambda x: natural_sort_key(x.name)):
        if entry.is_dir() and not entry.name.startswith('.'):
            has_content = any(
                f.suffix.lower() in VIDEO_EXTENSIONS | DOCUMENT_EXTENSIONS
                for f in entry.iterdir() if f.is_file()
            )
            dirs.append({
                'name': entry.name,
                'path': str(entry),
                'has_videos': has_content,
            })
    return jsonify(dirs)


@app.route('/api/tags')
@login_required
def api_get_tags():
    db = get_db()
    user_id = session['user_id']
    rows = db.execute(
        'SELECT DISTINCT tag_type, tag_value FROM course_tags WHERE user_id = ? ORDER BY tag_type, tag_value',
        (user_id,)
    ).fetchall()
    sources = [r['tag_value'] for r in rows if r['tag_type'] == 'source']
    categories = [r['tag_value'] for r in rows if r['tag_type'] == 'category']
    return jsonify({'sources': sources, 'categories': categories})


@app.route('/api/courses/<path:course_path>/tags')
@login_required
def api_get_course_tags(course_path):
    db = get_db()
    user_id = session['user_id']
    rows = db.execute(
        'SELECT id, tag_type, tag_value FROM course_tags WHERE user_id = ? AND course_path = ?',
        (user_id, course_path)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/courses/<path:course_path>/tags', methods=['POST'])
@login_required
def api_add_course_tag(course_path):
    validate_csrf()
    data = request.json
    db = get_db()
    user_id = session['user_id']

    tag_type = data.get('tag_type', '').strip()
    tag_value = data.get('tag_value', '').strip()

    if tag_type not in ('source', 'category') or not tag_value:
        return jsonify({'error': 'Invalid tag'}), 400

    try:
        db.execute(
            'INSERT INTO course_tags (user_id, course_path, tag_type, tag_value) VALUES (?, ?, ?, ?)',
            (user_id, course_path, tag_type, tag_value)
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Tag already exists'}), 409

    return jsonify({'ok': True})


@app.route('/api/courses/<path:course_path>/tags/<int:tag_id>', methods=['DELETE'])
@login_required
def api_delete_course_tag(course_path, tag_id):
    validate_csrf()
    db = get_db()
    user_id = session['user_id']
    db.execute('DELETE FROM course_tags WHERE id = ? AND user_id = ?', (tag_id, user_id))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/lesson-order/<path:course_path>', methods=['GET'])
@login_required
def api_get_lesson_order(course_path):
    db = get_db()
    row = db.execute(
        'SELECT ordered_paths FROM lesson_order WHERE user_id = ? AND course_path = ?',
        (session['user_id'], course_path)
    ).fetchone()
    return jsonify({'order': json.loads(row['ordered_paths']) if row else None})


@app.route('/api/lesson-order/<path:course_path>', methods=['PUT'])
@login_required
def api_save_lesson_order(course_path):
    validate_csrf()
    data = request.json
    order = data.get('order')
    if not isinstance(order, (list, dict)):
        return jsonify({'error': 'Invalid order'}), 400

    db = get_db()
    db.execute(
        'INSERT INTO lesson_order (user_id, course_path, ordered_paths) VALUES (?, ?, ?) '
        'ON CONFLICT(user_id, course_path) DO UPDATE SET ordered_paths = excluded.ordered_paths',
        (session['user_id'], course_path, json.dumps(order))
    )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/lesson-order/<path:course_path>', methods=['DELETE'])
@login_required
def api_delete_lesson_order(course_path):
    validate_csrf()
    db = get_db()
    db.execute(
        'DELETE FROM lesson_order WHERE user_id = ? AND course_path = ?',
        (session['user_id'], course_path)
    )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/account', methods=['PUT'])
@login_required
def api_update_account():
    validate_csrf()
    data = request.json
    db = get_db()
    user_id = session['user_id']

    current_password = data.get('current_password', '')
    user = db.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()

    if not bcrypt.checkpw(current_password.encode('utf-8'), user['password_hash'].encode('utf-8')):
        return jsonify({'error': 'Current password is incorrect'}), 403

    new_username = data.get('username', '').strip()
    new_password = data.get('new_password', '').strip()

    if new_username and new_username != user['username']:
        existing = db.execute('SELECT id FROM users WHERE username = ? AND id != ?', (new_username, user_id)).fetchone()
        if existing:
            return jsonify({'error': 'Username already taken'}), 409
        db.execute('UPDATE users SET username = ? WHERE id = ?', (new_username, user_id))
        session['username'] = new_username

    if new_password:
        if len(new_password) < 4:
            return jsonify({'error': 'Password must be at least 4 characters'}), 400
        hashed = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
        db.execute('UPDATE users SET password_hash = ? WHERE id = ?', (hashed, user_id))

    db.commit()
    return jsonify({'ok': True, 'username': session.get('username')})


def _get_mime(path):
    mimes = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.m4v': 'video/mp4',
    }
    return mimes.get(path.suffix.lower(), 'application/octet-stream')


# Browser-supported video codecs
BROWSER_VIDEO_CODECS = {'h264', 'vp8', 'vp9', 'av1', 'theora'}


def _get_video_codec(path):
    """Get video codec name using ffprobe."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', str(path)],
            capture_output=True, text=True, timeout=10
        )
        return result.stdout.strip().lower() if result.returncode == 0 else None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def _get_video_duration(path):
    """Get video duration in seconds using ffprobe."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', str(path)],
            capture_output=True, text=True, timeout=10
        )
        return float(result.stdout.strip()) if result.returncode == 0 else 0
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError):
        return 0


# Track active transcode processes
_active_transcodes = {}


@app.route('/api/transcode/scan')
@login_required
def api_transcode_scan():
    """Scan all libraries for videos with browser-incompatible codecs.
    Streams newline-delimited JSON so the frontend can show live progress.
    Events: {type:'progress', scanned, total, found} and final {type:'done', files, backup_count, backup_size_mb}
    """
    user_id = session['user_id']
    lib_paths = get_library_paths(user_id)

    def generate():
        # First pass: collect all video files to get a total count
        all_videos = []
        for lib_path in lib_paths:
            if not lib_path.exists():
                continue
            for video_file in lib_path.rglob('*'):
                if not video_file.is_file():
                    continue
                if video_file.suffix.lower() not in VIDEO_EXTENSIONS:
                    continue
                if video_file.name.startswith('.') or '.transcoded' in video_file.name:
                    continue
                all_videos.append((video_file, lib_path))

        total = len(all_videos)
        incompatible = []
        scanned = 0

        # Send initial count
        yield json.dumps({'type': 'progress', 'scanned': 0, 'total': total, 'found': 0, 'file': ''}) + '\n'

        for video_file, lib_path in all_videos:
            scanned += 1
            rel = str(video_file.relative_to(lib_path))
            codec = _get_video_codec(video_file)
            if codec and codec not in BROWSER_VIDEO_CODECS:
                transcoded = video_file.with_suffix('.transcoded.mp4')
                backup = video_file.with_name(video_file.name + '.bak')
                size_mb = round(video_file.stat().st_size / (1024 * 1024), 1)
                incompatible.append({
                    'path': rel,
                    'library': str(lib_path),
                    'codec': codec,
                    'size_mb': size_mb,
                    'has_transcoded': transcoded.exists(),
                    'has_backup': backup.exists(),
                })

            yield json.dumps({'type': 'progress', 'scanned': scanned, 'total': total, 'found': len(incompatible), 'file': rel}) + '\n'

        # Count backups
        backup_count = 0
        backup_size = 0
        for lib_path in lib_paths:
            if not lib_path.exists():
                continue
            for bak in lib_path.rglob('*.bak'):
                if bak.is_file():
                    backup_count += 1
                    backup_size += bak.stat().st_size

        yield json.dumps({
            'type': 'done',
            'files': incompatible,
            'backup_count': backup_count,
            'backup_size_mb': round(backup_size / (1024 * 1024), 1),
        }) + '\n'

    return Response(generate(), mimetype='application/x-ndjson')


@app.route('/api/transcode/start', methods=['POST'])
@login_required
def api_transcode_start():
    """Start transcoding a single file to H.264."""
    validate_csrf()
    data = request.json
    rel_path = data.get('path', '')
    library = data.get('library', '')

    if not rel_path or not library:
        return jsonify({'error': 'Missing path or library'}), 400

    lib_path = Path(library)
    video_path = safe_path(lib_path, rel_path)
    if not video_path.exists():
        return jsonify({'error': 'File not found'}), 404

    transcoded_path = video_path.with_suffix('.transcoded.mp4')
    if transcoded_path.exists():
        return jsonify({'error': 'Transcoded file already exists'}), 409

    task_key = str(video_path)
    if task_key in _active_transcodes:
        return jsonify({'error': 'Already transcoding'}), 409

    # Get duration for progress tracking
    duration = _get_video_duration(video_path)

    # Create temp file for ffmpeg progress output
    progress_file = tempfile.NamedTemporaryFile(mode='w', suffix='.log', delete=False)
    progress_path = progress_file.name
    progress_file.close()

    # Start ffmpeg with -progress flag writing to temp file
    process = subprocess.Popen(
        ['ffmpeg', '-i', str(video_path), '-c:v', 'libx264', '-crf', '18',
         '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart',
         '-progress', progress_path, '-y', str(transcoded_path)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    _active_transcodes[task_key] = {
        'process': process,
        'duration': duration,
        'progress_file': progress_path,
    }

    return jsonify({'ok': True, 'task_key': task_key})


@app.route('/api/transcode/status', methods=['POST'])
@login_required
def api_transcode_status():
    """Check status of a transcode job."""
    validate_csrf()
    data = request.json
    task_key = data.get('task_key', '')

    if task_key not in _active_transcodes:
        return jsonify({'status': 'unknown'})

    task = _active_transcodes[task_key]
    process = task['process']
    poll = process.poll()

    if poll is None:
        # Still running — parse progress file for percentage
        percent = 0
        try:
            with open(task['progress_file'], 'r') as f:
                content = f.read()
            # Find last out_time_us (microseconds) in progress output
            matches = re.findall(r'out_time_us=(\d+)', content)
            if matches and task['duration'] > 0:
                current_us = int(matches[-1])
                current_secs = current_us / 1_000_000
                percent = min(99, round((current_secs / task['duration']) * 100))
        except (OSError, ValueError):
            pass
        return jsonify({'status': 'running', 'percent': percent})

    # Done — clean up
    progress_path = task['progress_file']
    del _active_transcodes[task_key]
    try:
        os.unlink(progress_path)
    except OSError:
        pass

    if poll == 0:
        return jsonify({'status': 'complete'})
    else:
        return jsonify({'status': 'error', 'message': 'Transcode failed'})


@app.route('/api/transcode/accept', methods=['POST'])
@login_required
def api_transcode_accept():
    """Accept a transcode: rename original to .bak, rename .transcoded to original."""
    validate_csrf()
    data = request.json
    rel_path = data.get('path', '')
    library = data.get('library', '')

    lib_path = Path(library)
    video_path = safe_path(lib_path, rel_path)
    transcoded_path = video_path.with_suffix('.transcoded.mp4')

    if not transcoded_path.exists():
        return jsonify({'error': 'No transcoded file found'}), 404

    backup_path = video_path.with_name(video_path.name + '.bak')
    video_path.rename(backup_path)
    transcoded_path.rename(video_path)

    return jsonify({'ok': True})


@app.route('/api/transcode/reject', methods=['POST'])
@login_required
def api_transcode_reject():
    """Reject a transcode: delete the .transcoded file."""
    validate_csrf()
    data = request.json
    rel_path = data.get('path', '')
    library = data.get('library', '')

    lib_path = Path(library)
    video_path = safe_path(lib_path, rel_path)
    transcoded_path = video_path.with_suffix('.transcoded.mp4')

    if transcoded_path.exists():
        transcoded_path.unlink()

    return jsonify({'ok': True})


@app.route('/api/transcode/cleanup', methods=['POST'])
@login_required
def api_transcode_cleanup():
    """Delete all .bak backup files across libraries."""
    validate_csrf()
    user_id = session['user_id']
    lib_paths = get_library_paths(user_id)
    deleted = 0

    for lib_path in lib_paths:
        if not lib_path.exists():
            continue
        for bak in lib_path.rglob('*.bak'):
            if bak.is_file():
                bak.unlink()
                deleted += 1

    return jsonify({'ok': True, 'deleted': deleted})


@app.route('/api/transcode/accept-all', methods=['POST'])
@login_required
def api_transcode_accept_all():
    """Accept all completed transcodes."""
    validate_csrf()
    user_id = session['user_id']
    lib_paths = get_library_paths(user_id)
    accepted = 0

    for lib_path in lib_paths:
        if not lib_path.exists():
            continue
        for transcoded in lib_path.rglob('*.transcoded.mp4'):
            if not transcoded.is_file():
                continue
            # Find the original file
            original_name = transcoded.name.replace('.transcoded.mp4', '.mp4')
            original = transcoded.parent / original_name
            if original.exists():
                backup = original.with_name(original.name + '.bak')
                original.rename(backup)
                transcoded.rename(original)
                accepted += 1

    return jsonify({'ok': True, 'accepted': accepted})


@app.route('/api/transcode/trash')
@login_required
def api_transcode_trash():
    """List all .bak backup files across libraries."""
    user_id = session['user_id']
    lib_paths = get_library_paths(user_id)
    files = []
    total_size = 0

    for lib_path in lib_paths:
        if not lib_path.exists():
            continue
        for bak in lib_path.rglob('*.bak'):
            if not bak.is_file():
                continue
            size = bak.stat().st_size
            total_size += size
            rel = str(bak.relative_to(lib_path))
            files.append({
                'path': rel,
                'library': str(lib_path),
                'size_mb': round(size / (1024 * 1024), 1),
            })

    return jsonify({
        'files': files,
        'total_size_mb': round(total_size / (1024 * 1024), 1),
    })


@app.route('/api/transcode/trash/restore', methods=['POST'])
@login_required
def api_transcode_trash_restore():
    """Restore a .bak file back to its original name."""
    validate_csrf()
    data = request.json
    rel_path = data.get('path', '')
    library = data.get('library', '')

    lib_path = Path(library)
    bak_path = safe_path(lib_path, rel_path)

    if not bak_path.exists() or not bak_path.name.endswith('.bak'):
        return jsonify({'error': 'Backup file not found'}), 404

    # Original name is the .bak name without the .bak suffix
    original_path = bak_path.with_name(bak_path.name[:-4])

    # If a transcoded replacement exists at the original path, remove it
    if original_path.exists():
        original_path.unlink()

    bak_path.rename(original_path)
    return jsonify({'ok': True})


with app.app_context():
    init_db()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5050))
    app.run(host='0.0.0.0', port=port, debug=True)
