/* === CourseView Application === */

(function () {
    'use strict';

    const CSRF = window.__CSRF_TOKEN__;
    const state = {
        courses: [],
        currentCourse: null,
        currentLesson: null,
        currentLessonIndex: -1,
        progress: {},
        saveTimer: null,
        settings: {},
        libraries: [],
        allTags: { sources: [], categories: [] },
    };

    // --- Helpers ---

    function api(url, opts = {}) {
        const headers = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': CSRF };
        if (opts.body && typeof opts.body === 'object') {
            headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(opts.body);
        }
        return fetch(url, { ...opts, headers: { ...headers, ...opts.headers } })
            .then(r => {
                if (r.status === 401) { window.location.href = '/login'; return; }
                return r.json();
            });
    }

    function formatTime(s) {
        if (!s || isNaN(s)) return '0:00';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        return `${m}:${String(sec).padStart(2, '0')}`;
    }

    function el(id) { return document.getElementById(id); }
    function qs(sel, parent) { return (parent || document).querySelector(sel); }

    // --- DOM refs ---

    const video = el('video-player');
    const playBtn = el('play-btn');
    const playIcon = el('play-icon');
    const pauseIcon = el('pause-icon');
    const prevBtn = el('prev-btn');
    const nextBtn = el('next-btn');
    const timeDisplay = el('time-display');
    const progressContainer = el('progress-container');
    const progressBar = el('progress-bar');
    const bufferedBar = el('buffered-bar');
    const speedBtn = el('speed-btn');
    const speedMenu = el('speed-menu');
    const subBtn = el('sub-btn');
    const completeBtn = el('complete-btn');
    const fullscreenBtn = el('fullscreen-btn');
    const searchInput = el('search-input');
    const searchResults = el('search-results');
    const overlay = el('player-overlay');
    const overlayIcon = el('overlay-icon');
    const documentViewer = el('document-viewer');
    const docPdfIframe = el('doc-pdf-iframe');
    const docTextContainer = el('doc-text-container');
    const docTextContent = el('doc-text-content');
    const videoWrapper = qs('.video-wrapper');
    const playerControls = qs('.player-controls');
    const volumeBtn = el('volume-btn');
    const volumeSlider = el('volume-slider');
    const volumeIcon = el('volume-icon');
    const volumeMutedIcon = el('volume-muted-icon');

    // --- Views ---

    function showView(name) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        el(`view-${name}`).classList.add('active');
        document.querySelectorAll('#sidebar-nav .nav-item').forEach(n => {
            n.classList.toggle('active', n.dataset.view === name);
        });
    }

    // Nav item click handlers
    document.querySelectorAll('#sidebar-nav .nav-item[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            if (view === 'dashboard') {
                if (state.currentCourse) {
                    saveProgress();
                    video.pause();
                    video.src = '';
                    cleanupDocumentViewer();
                    videoWrapper.classList.remove('hidden');
                    playerControls.classList.remove('hidden');
                    state.currentCourse = null;
                    state.currentLesson = null;
                    state.currentLessonIndex = -1;
                }
                loadDashboard();
            }
            closeSidebar();
        });
    });

    // Logo click → dashboard
    el('logo-home').addEventListener('click', () => {
        if (state.currentCourse) {
            saveProgress();
            video.pause();
            video.src = '';
            cleanupDocumentViewer();
            videoWrapper.classList.remove('hidden');
            playerControls.classList.remove('hidden');
            state.currentCourse = null;
            state.currentLesson = null;
            state.currentLessonIndex = -1;
        }
        loadDashboard();
        closeSidebar();
    });

    // Settings button in footer
    el('settings-btn').addEventListener('click', () => {
        if (state.currentCourse) {
            saveProgress();
            video.pause();
        }
        loadSettings();
        closeSidebar();
    });

    // --- Dashboard ---

    async function loadDashboard() {
        showView('dashboard');
        el('sidebar-nav').classList.remove('hidden');
        el('course-sidebar').classList.add('hidden');
        el('breadcrumb').innerHTML = '';

        const coursesGrid = el('courses-grid');
        coursesGrid.innerHTML = Array(4).fill('<div class="skeleton skeleton-card"></div>').join('');

        const [courses, continueItems] = await Promise.all([
            api('/api/courses'),
            api('/api/continue'),
        ]);

        state.courses = courses;

        // Continue watching - Netflix horizontal row
        const contSection = el('continue-section');
        const contList = el('continue-list');
        if (continueItems && continueItems.length > 0) {
            contSection.classList.remove('hidden');
            contList.innerHTML = continueItems.map(item => {
                const pct = item.duration > 0 ? (item.position / item.duration) * 100 : 0;
                return `
                    <div class="netflix-card continue-card" data-course="${esc(item.course_path)}" data-lesson="${esc(item.lesson_path)}">
                        <div class="continue-card-course">${esc(item.course_name)}</div>
                        <div class="continue-card-lesson">${esc(item.lesson_name)}</div>
                        <div class="continue-card-progress"><div class="continue-card-fill" style="width:${pct}%"></div></div>
                    </div>`;
            }).join('');

            contList.querySelectorAll('.continue-card').forEach(card => {
                card.addEventListener('click', () => {
                    const coursePath = card.dataset.course;
                    const lessonPath = card.dataset.lesson;
                    const course = state.courses.find(c => c.path === coursePath);
                    if (course) openCourse(course, lessonPath);
                });
            });
        } else {
            contSection.classList.add('hidden');
        }

        // Build tagged rows (Netflix-style)
        renderTaggedRows(courses);

        // All courses grid
        coursesGrid.innerHTML = courses.map(c => renderCourseCard(c)).join('');
        bindCourseCards(coursesGrid);
    }

    function renderCourseCard(c) {
        const tagPills = [];
        if (c.tags) {
            c.tags.sources.forEach(s => tagPills.push(`<span class="course-tag source-tag">${esc(s)}</span>`));
            c.tags.categories.forEach(cat => tagPills.push(`<span class="course-tag category-tag">${esc(cat)}</span>`));
        }
        return `
            <div class="course-card" data-path="${esc(c.path)}">
                <div class="course-card-top">
                    <div class="course-card-name">${esc(c.name)}</div>
                    <button class="course-tag-edit-btn" data-path="${esc(c.path)}" title="Edit tags">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-1.42.59H8v-4a2 2 0 0 1 .59-1.42l7.17-7.17m4.83 4.83l2.12-2.12a2 2 0 0 0 0-2.83l-1.17-1.17a2 2 0 0 0-2.83 0L16.76 8.58m4.83 4.83l-4.83-4.83"/></svg>
                    </button>
                </div>
                ${tagPills.length ? `<div class="course-tags-row">${tagPills.join('')}</div>` : ''}
                <div class="course-card-meta">${c.lessons.length} lesson${c.lessons.length !== 1 ? 's' : ''}</div>
                <div class="course-progress-bar"><div class="course-progress-fill" style="width:${c.progress}%"></div></div>
                <div class="course-progress-label">${c.progress}% complete</div>
            </div>`;
    }

    function renderNetflixCard(c) {
        return `
            <div class="netflix-card course-card" data-path="${esc(c.path)}">
                <div class="course-card-name">${esc(c.name)}</div>
                <div class="course-card-meta">${c.lessons.length} lesson${c.lessons.length !== 1 ? 's' : ''}</div>
                <div class="course-progress-bar"><div class="course-progress-fill" style="width:${c.progress}%"></div></div>
            </div>`;
    }

    function bindCourseCards(container) {
        container.querySelectorAll('.course-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't open course if clicking the tag edit button
                if (e.target.closest('.course-tag-edit-btn')) return;
                const course = state.courses.find(c => c.path === card.dataset.path);
                if (course) openCourse(course);
            });
        });
        container.querySelectorAll('.course-tag-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const coursePath = btn.dataset.path;
                const course = state.courses.find(c => c.path === coursePath);
                if (course) openTagEditor(course);
            });
        });
    }

    function renderTaggedRows(courses) {
        const container = el('tagged-rows');
        container.innerHTML = '';

        // Collect all unique sources and categories
        const sourceMap = {};
        const categoryMap = {};

        courses.forEach(c => {
            if (!c.tags) return;
            c.tags.sources.forEach(s => {
                if (!sourceMap[s]) sourceMap[s] = [];
                sourceMap[s].push(c);
            });
            c.tags.categories.forEach(cat => {
                if (!categoryMap[cat]) categoryMap[cat] = [];
                categoryMap[cat].push(c);
            });
        });

        // Render source rows
        Object.keys(sourceMap).sort().forEach(source => {
            container.innerHTML += renderNetflixRow(source, sourceMap[source]);
        });

        // Render category rows
        Object.keys(categoryMap).sort().forEach(cat => {
            container.innerHTML += renderNetflixRow(cat, categoryMap[cat]);
        });

        // Bind click handlers on all netflix cards
        container.querySelectorAll('.course-card').forEach(card => {
            card.addEventListener('click', () => {
                const course = state.courses.find(c => c.path === card.dataset.path);
                if (course) openCourse(course);
            });
        });
    }

    function renderNetflixRow(label, courses) {
        return `
            <div class="section netflix-section">
                <h2 class="section-title">${esc(label)}</h2>
                <div class="netflix-row">
                    ${courses.map(c => renderNetflixCard(c)).join('')}
                </div>
            </div>`;
    }

    // --- Course View ---

    async function openCourse(course, autoPlayLesson) {
        state.currentCourse = course;
        showView('player');

        el('sidebar-nav').classList.add('hidden');
        el('course-sidebar').classList.remove('hidden');

        el('breadcrumb').innerHTML = `
            <span class="sep">/</span>
            <span>${esc(course.name)}</span>
        `;

        // Load progress
        state.progress = await api(`/api/progress/${encodeURIComponent(course.path)}`);

        renderLessonList(course);

        // Auto-play lesson
        const target = autoPlayLesson || course.lessons[0]?.path;
        if (target) {
            const idx = course.lessons.findIndex(l => l.path === target);
            if (idx >= 0) playLesson(idx);
        }
    }

    function renderMarkdown(text) {
        let html = text
            .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
            .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
            .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
            .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
            .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
            .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/^>\s+(.+)$/gm, '<blockquote><p>$1</p></blockquote>')
            .replace(/^---$/gm, '<hr>')
            .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>')
            .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
        // Wrap consecutive <li> in <ul>
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
        // Wrap remaining bare lines in <p>
        html = html.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('<')) return line;
            return `<p>${trimmed}</p>`;
        }).join('\n');
        return html;
    }

    function cleanupDocumentViewer() {
        documentViewer.classList.add('hidden');
        docPdfIframe.classList.add('hidden');
        docPdfIframe.src = '';
        docTextContainer.classList.add('hidden');
        docTextContent.innerHTML = '';
    }

    function renderLessonList(course) {
        const list = el('lesson-list');
        let html = '';
        let currentSection = null;

        for (let i = 0; i < course.lessons.length; i++) {
            const lesson = course.lessons[i];
            const prog = state.progress[lesson.path];
            const completed = prog && prog.completed;
            const section = lesson.section || '';

            if (section !== currentSection) {
                currentSection = section;
                if (section) html += `<div class="lesson-section-title">${esc(formatSectionName(section))}</div>`;
            }

            const docIcon = lesson.type === 'document'
                ? '<span class="lesson-type-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>'
                : '';

            html += `
                <button class="lesson-item${i === state.currentLessonIndex ? ' active' : ''}" data-index="${i}" data-path="${esc(lesson.path)}" draggable="false">
                    <span class="drag-handle"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg></span>
                    <span class="check${completed ? ' completed' : ''}">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </span>
                    ${docIcon}
                    <span>${esc(lesson.name)}</span>
                </button>`;
        }

        list.innerHTML = html;
        list.querySelectorAll('.lesson-item').forEach(item => {
            item.addEventListener('click', () => {
                if (!state.reorderMode) playLesson(parseInt(item.dataset.index));
            });
        });
    }

    function formatSectionName(path) {
        const name = path.split('/').pop();
        return name.replace(/^\d+[\s._-]*/, '').replace(/[_-]/g, ' ').trim() || name;
    }

    // --- Lesson Reorder ---

    state.reorderMode = false;
    let dragItem = null;

    el('reorder-btn').addEventListener('click', () => {
        if (state.reorderMode) {
            exitReorderMode();
        } else {
            enterReorderMode();
        }
    });

    function enterReorderMode() {
        state.reorderMode = true;
        el('reorder-btn').classList.add('active');
        el('reorder-controls').classList.remove('hidden');
        const list = el('lesson-list');
        list.classList.add('reorder-mode');
        list.querySelectorAll('.lesson-item').forEach(item => {
            item.draggable = true;
            item.addEventListener('dragstart', onDragStart);
            item.addEventListener('dragover', onDragOver);
            item.addEventListener('dragleave', onDragLeave);
            item.addEventListener('drop', onDrop);
            item.addEventListener('dragend', onDragEnd);
        });
    }

    function exitReorderMode() {
        state.reorderMode = false;
        el('reorder-btn').classList.remove('active');
        el('reorder-controls').classList.add('hidden');
        const list = el('lesson-list');
        list.classList.remove('reorder-mode');
        list.querySelectorAll('.lesson-item').forEach(item => {
            item.draggable = false;
            item.removeEventListener('dragstart', onDragStart);
            item.removeEventListener('dragover', onDragOver);
            item.removeEventListener('dragleave', onDragLeave);
            item.removeEventListener('drop', onDrop);
            item.removeEventListener('dragend', onDragEnd);
        });
    }

    function onDragStart(e) {
        dragItem = this;
        this.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    }

    function onDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (this !== dragItem) {
            this.classList.add('drag-over');
        }
    }

    function onDragLeave() {
        this.classList.remove('drag-over');
    }

    function onDrop(e) {
        e.preventDefault();
        this.classList.remove('drag-over');
        if (this === dragItem) return;

        const list = el('lesson-list');
        const items = [...list.querySelectorAll('.lesson-item')];
        const fromIdx = items.indexOf(dragItem);
        const toIdx = items.indexOf(this);

        if (fromIdx < toIdx) {
            this.after(dragItem);
        } else {
            this.before(dragItem);
        }

        // Update data-index attributes
        list.querySelectorAll('.lesson-item').forEach((item, i) => {
            item.dataset.index = i;
        });
    }

    function onDragEnd() {
        this.classList.remove('dragging');
        el('lesson-list').querySelectorAll('.lesson-item').forEach(i => i.classList.remove('drag-over'));
        dragItem = null;
    }

    el('reorder-save').addEventListener('click', async () => {
        const course = state.currentCourse;
        if (!course) return;

        const items = el('lesson-list').querySelectorAll('.lesson-item');
        const order = [...items].map(item => item.dataset.path);

        await api(`/api/lesson-order/${encodeURIComponent(course.path)}`, {
            method: 'PUT',
            body: { order },
        });

        // Re-fetch courses to get the updated order
        exitReorderMode();
        const courses = await api('/api/courses');
        state.courses = courses || [];
        const updated = state.courses.find(c => c.path === course.path);
        if (updated) {
            state.currentCourse = updated;
            renderLessonList(updated);
        }
    });

    el('reorder-reset').addEventListener('click', async () => {
        const course = state.currentCourse;
        if (!course) return;

        await api(`/api/lesson-order/${encodeURIComponent(course.path)}`, {
            method: 'DELETE',
        });

        exitReorderMode();
        const courses = await api('/api/courses');
        state.courses = courses || [];
        const updated = state.courses.find(c => c.path === course.path);
        if (updated) {
            state.currentCourse = updated;
            renderLessonList(updated);
        }
    });

    el('reorder-cancel').addEventListener('click', () => {
        exitReorderMode();
        if (state.currentCourse) renderLessonList(state.currentCourse);
    });

    // --- Video Player ---

    function playLesson(index) {
        const course = state.currentCourse;
        if (!course || !course.lessons[index]) return;

        saveProgress();
        state.currentLessonIndex = index;
        const lesson = course.lessons[index];
        state.currentLesson = lesson;

        if (lesson.type === 'document') {
            showDocument(lesson);
        } else {
            showVideo(lesson);
        }

        updateLessonHighlight();
        loadNotes();
        updateCompletionBtn();

        el('breadcrumb').innerHTML = `
            <span class="sep">/</span>
            <span>${esc(course.name)}</span>
            <span class="sep">/</span>
            <span>${esc(lesson.name)}</span>
        `;

        closeSidebar();
        updateNextLessonBar();
    }

    function showVideo(lesson) {
        const course = state.currentCourse;
        cleanupDocumentViewer();
        videoWrapper.classList.remove('hidden');
        playerControls.classList.remove('hidden');
        el('note-input').placeholder = 'Add a note at current timestamp...';

        const videoUrl = `/video/${encodeURIComponent(course.path)}/${encodeURIComponent(lesson.path)}`;
        video.src = videoUrl;

        while (video.firstChild) video.removeChild(video.firstChild);
        if (lesson.subtitles) {
            lesson.subtitles.forEach(sub => {
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.label = sub.lang || 'Default';
                track.src = `/subtitle/${encodeURIComponent(sub.path)}`;
                if (sub.ext === '.vtt') track.srclang = sub.lang || 'en';
                video.appendChild(track);
            });
        }

        const prog = state.progress[lesson.path];
        if (prog && prog.position > 0 && !prog.completed) {
            video.currentTime = prog.position;
        }

        video.play().catch(() => {});
    }

    function showDocument(lesson) {
        const course = state.currentCourse;
        video.pause();
        video.src = '';
        videoWrapper.classList.add('hidden');
        playerControls.classList.add('hidden');
        documentViewer.classList.remove('hidden');
        el('note-input').placeholder = 'Add a note...';

        if (lesson.format === 'pdf') {
            docPdfIframe.classList.remove('hidden');
            docTextContainer.classList.add('hidden');
            docPdfIframe.src = `/document/${encodeURIComponent(course.path)}/${encodeURIComponent(lesson.path)}`;
        } else {
            docPdfIframe.classList.add('hidden');
            docTextContainer.classList.remove('hidden');
            api(`/document/${encodeURIComponent(course.path)}/${encodeURIComponent(lesson.path)}`)
                .then(data => {
                    if (!data) return;
                    if (lesson.format === 'markdown') {
                        docTextContent.innerHTML = renderMarkdown(data.content);
                    } else {
                        const pre = document.createElement('pre');
                        pre.textContent = data.content;
                        docTextContent.innerHTML = '';
                        docTextContent.appendChild(pre);
                    }
                });
        }
    }

    function updateNextLessonBar() {
        const bar = el('lesson-nav-bar');
        const course = state.currentCourse;
        if (!course) { bar.classList.add('hidden'); return; }

        const prevBtn = el('prev-lesson-btn');
        const prevLabel = el('prev-lesson-label');
        const nextBtn = el('next-lesson-btn');
        const nextLabel = el('next-lesson-label');

        const hasPrev = state.currentLessonIndex > 0;
        const hasNext = state.currentLessonIndex < course.lessons.length - 1;

        if (!hasPrev && !hasNext) { bar.classList.add('hidden'); return; }

        prevBtn.disabled = !hasPrev;
        prevLabel.textContent = hasPrev ? course.lessons[state.currentLessonIndex - 1].name : 'Previous';

        nextBtn.disabled = !hasNext;
        nextLabel.textContent = hasNext ? course.lessons[state.currentLessonIndex + 1].name : 'Next Lesson';

        bar.classList.remove('hidden');
    }

    el('prev-lesson-btn').addEventListener('click', () => {
        if (state.currentCourse && state.currentLessonIndex > 0) {
            playLesson(state.currentLessonIndex - 1);
        }
    });

    el('next-lesson-btn').addEventListener('click', () => {
        if (state.currentCourse && state.currentLessonIndex < state.currentCourse.lessons.length - 1) {
            markComplete();
            playLesson(state.currentLessonIndex + 1);
        }
    });

    function updateLessonHighlight() {
        el('lesson-list').querySelectorAll('.lesson-item').forEach((item, i) => {
            item.classList.toggle('active', i === state.currentLessonIndex);
        });
    }

    function updateCompletionBtn() {
        const lesson = state.currentLesson;
        if (!lesson) return;
        const prog = state.progress[lesson.path];
        completeBtn.classList.toggle('active', !!(prog && prog.completed));
    }

    // Play/pause
    playBtn.addEventListener('click', togglePlay);

    function togglePlay() {
        if (video.paused) {
            video.play();
            showOverlayIcon('&#9654;');
        } else {
            video.pause();
            showOverlayIcon('&#9646;&#9646;');
        }
    }

    video.addEventListener('play', () => {
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');
    });

    video.addEventListener('pause', () => {
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
    });

    // Time updates
    video.addEventListener('timeupdate', () => {
        const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
        progressBar.style.width = pct + '%';
        timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    });

    video.addEventListener('progress', () => {
        if (video.buffered.length > 0) {
            const end = video.buffered.end(video.buffered.length - 1);
            const pct = video.duration ? (end / video.duration) * 100 : 0;
            bufferedBar.style.width = pct + '%';
        }
    });

    // Progress bar seek
    progressContainer.addEventListener('click', e => {
        const rect = progressContainer.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        video.currentTime = pct * video.duration;
    });

    // Auto-save progress periodically
    video.addEventListener('timeupdate', () => {
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(saveProgress, 5000);
    });

    video.addEventListener('pause', saveProgress);

    video.addEventListener('ended', () => {
        markComplete();
        const autoAdv = state.settings.auto_advance !== 'false';
        if (autoAdv && state.currentLessonIndex < state.currentCourse.lessons.length - 1) {
            setTimeout(() => playLesson(state.currentLessonIndex + 1), 1500);
        }
    });

    // Prev/Next
    prevBtn.addEventListener('click', () => {
        if (state.currentLessonIndex > 0) playLesson(state.currentLessonIndex - 1);
    });

    nextBtn.addEventListener('click', () => {
        if (state.currentCourse && state.currentLessonIndex < state.currentCourse.lessons.length - 1)
            playLesson(state.currentLessonIndex + 1);
    });

    // Speed
    speedBtn.addEventListener('click', e => {
        e.stopPropagation();
        speedMenu.classList.toggle('hidden');
    });

    speedMenu.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            const speed = parseFloat(btn.dataset.speed);
            video.playbackRate = speed;
            speedBtn.textContent = btn.textContent;
            speedMenu.classList.add('hidden');
            speedMenu.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    document.addEventListener('click', () => speedMenu.classList.add('hidden'));

    // Subtitles toggle
    subBtn.addEventListener('click', () => {
        const tracks = video.textTracks;
        if (tracks.length === 0) return;
        const track = tracks[0];
        track.mode = track.mode === 'showing' ? 'hidden' : 'showing';
        subBtn.classList.toggle('active', track.mode === 'showing');
    });

    // Mark complete
    completeBtn.addEventListener('click', () => {
        const lesson = state.currentLesson;
        if (!lesson) return;
        const prog = state.progress[lesson.path];
        const isComplete = prog && prog.completed;
        if (isComplete) {
            markIncomplete();
        } else {
            markComplete();
        }
    });

    // Fullscreen
    fullscreenBtn.addEventListener('click', () => {
        const wrapper = qs('.video-wrapper');
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            wrapper.requestFullscreen().catch(() => {});
        }
    });

    // Volume
    function updateVolumeUI() {
        const muted = video.muted || video.volume === 0;
        volumeIcon.classList.toggle('hidden', muted);
        volumeMutedIcon.classList.toggle('hidden', !muted);
        volumeSlider.value = video.muted ? 0 : video.volume;
    }

    volumeSlider.addEventListener('input', () => {
        video.volume = parseFloat(volumeSlider.value);
        video.muted = video.volume === 0;
        updateVolumeUI();
    });

    volumeBtn.addEventListener('click', () => {
        video.muted = !video.muted;
        updateVolumeUI();
        showOverlayIcon(video.muted ? '&#128263;' : '&#128266;');
    });

    // Overlay
    function showOverlayIcon(html) {
        overlayIcon.innerHTML = html;
        overlay.classList.remove('hidden');
        clearTimeout(overlay._timer);
        overlay._timer = setTimeout(() => overlay.classList.add('hidden'), 600);
    }

    // Click video to play/pause
    video.addEventListener('click', togglePlay);

    // --- Progress ---

    function saveProgress() {
        const course = state.currentCourse;
        const lesson = state.currentLesson;
        if (!course || !lesson) return;
        if (lesson.type === 'document' || !video.duration) return;

        const prog = state.progress[lesson.path] || {};
        api('/api/progress', {
            method: 'POST',
            body: {
                course_path: course.path,
                lesson_path: lesson.path,
                position: video.currentTime,
                duration: video.duration,
                completed: !!prog.completed,
            },
        });

        state.progress[lesson.path] = {
            ...prog,
            position: video.currentTime,
            duration: video.duration,
        };
    }

    function markComplete() {
        const course = state.currentCourse;
        const lesson = state.currentLesson;
        if (!course || !lesson) return;

        state.progress[lesson.path] = {
            ...(state.progress[lesson.path] || {}),
            completed: 1,
        };

        const isDoc = lesson.type === 'document';
        api('/api/progress', {
            method: 'POST',
            body: {
                course_path: course.path,
                lesson_path: lesson.path,
                position: isDoc ? 0 : (video.currentTime || 0),
                duration: isDoc ? 0 : (video.duration || 0),
                completed: true,
            },
        });

        updateCompletionBtn();
        renderLessonList(course);
    }

    function markIncomplete() {
        const course = state.currentCourse;
        const lesson = state.currentLesson;
        if (!course || !lesson) return;

        state.progress[lesson.path] = {
            ...(state.progress[lesson.path] || {}),
            completed: 0,
        };

        const isDoc = lesson.type === 'document';
        api('/api/progress', {
            method: 'POST',
            body: {
                course_path: course.path,
                lesson_path: lesson.path,
                position: isDoc ? 0 : (video.currentTime || 0),
                duration: isDoc ? 0 : (video.duration || 0),
                completed: false,
            },
        });

        updateCompletionBtn();
        renderLessonList(course);
    }

    // --- Notes ---

    async function loadNotes() {
        const course = state.currentCourse;
        const lesson = state.currentLesson;
        if (!course || !lesson) return;

        const notes = await api(`/api/notes/${encodeURIComponent(course.path)}/${encodeURIComponent(lesson.path)}`);
        renderNotes(notes || []);
    }

    function renderNotes(notes) {
        const list = el('notes-list');
        const isDoc = state.currentLesson && state.currentLesson.type === 'document';
        if (!notes.length) {
            list.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-muted);font-size:0.8rem;">No notes yet</div>';
            return;
        }

        list.innerHTML = notes.map(n => `
            <div class="note-item" data-id="${n.id}">
                <button class="note-delete" data-id="${n.id}">&times;</button>
                ${isDoc ? '' : `<span class="note-timestamp" data-time="${n.timestamp}">${formatTime(n.timestamp)}</span>`}
                <div class="note-content">${esc(n.content)}</div>
            </div>
        `).join('');

        if (!isDoc) {
            list.querySelectorAll('.note-timestamp').forEach(ts => {
                ts.addEventListener('click', () => {
                    video.currentTime = parseFloat(ts.dataset.time);
                    video.play().catch(() => {});
                });
            });
        }

        list.querySelectorAll('.note-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                await api(`/api/notes/${btn.dataset.id}`, { method: 'DELETE' });
                loadNotes();
            });
        });
    }

    el('add-note-btn').addEventListener('click', addNote);
    el('note-input').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); }
    });

    async function addNote() {
        const input = el('note-input');
        const content = input.value.trim();
        if (!content || !state.currentCourse || !state.currentLesson) return;

        await api('/api/notes', {
            method: 'POST',
            body: {
                course_path: state.currentCourse.path,
                lesson_path: state.currentLesson.path,
                timestamp: (state.currentLesson && state.currentLesson.type === 'document') ? 0 : (video.currentTime || 0),
                content,
            },
        });

        input.value = '';
        loadNotes();
    }

    // --- Search ---

    let searchDebounce;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        const q = searchInput.value.trim();
        if (q.length < 2) {
            searchResults.classList.add('hidden');
            return;
        }
        searchDebounce = setTimeout(async () => {
            const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
            renderSearchResults(results || []);
        }, 250);
    });

    searchInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            searchResults.classList.add('hidden');
        }
    });

    function renderSearchResults(results) {
        if (!results.length) {
            searchResults.innerHTML = '<div style="padding:0.75rem;text-align:center;color:var(--text-muted);font-size:0.8rem;">No results</div>';
            searchResults.classList.remove('hidden');
            return;
        }

        searchResults.innerHTML = results.map(r => {
            if (r.type === 'course') {
                return `<div class="search-result-item" data-type="course" data-course="${esc(r.course_path)}">
                    <span class="search-result-type">Course</span>
                    <div><div class="search-result-name">${esc(r.name)}</div></div>
                </div>`;
            } else if (r.type === 'lesson') {
                return `<div class="search-result-item" data-type="lesson" data-course="${esc(r.course_path)}" data-lesson="${esc(r.lesson_path)}">
                    <span class="search-result-type">Lesson</span>
                    <div>
                        <div class="search-result-name">${esc(r.name)}</div>
                        <div class="search-result-sub">${esc(r.course_name)}</div>
                    </div>
                </div>`;
            } else {
                return `<div class="search-result-item" data-type="note" data-course="${esc(r.course_path)}" data-lesson="${esc(r.lesson_path)}" data-time="${r.timestamp}">
                    <span class="search-result-type">Note</span>
                    <div>
                        <div class="search-result-name">${esc(r.content.substring(0, 60))}</div>
                        <div class="search-result-sub">${formatTime(r.timestamp)}</div>
                    </div>
                </div>`;
            }
        }).join('');

        searchResults.classList.remove('hidden');

        searchResults.querySelectorAll('.search-result-item').forEach(item => {
            item.addEventListener('click', () => {
                const type = item.dataset.type;
                const coursePath = item.dataset.course;
                const course = state.courses.find(c => c.path === coursePath);

                if (type === 'course' && course) {
                    openCourse(course);
                } else if ((type === 'lesson' || type === 'note') && course) {
                    openCourse(course, item.dataset.lesson);
                }

                searchInput.value = '';
                searchResults.classList.add('hidden');
            });
        });
    }

    // --- Sidebar ---

    el('back-to-dashboard').addEventListener('click', () => {
        saveProgress();
        video.pause();
        video.src = '';
        state.currentCourse = null;
        state.currentLesson = null;
        state.currentLessonIndex = -1;
        loadDashboard();
    });

    // Mobile sidebar
    el('menu-toggle').addEventListener('click', openSidebar);
    el('sidebar-close').addEventListener('click', closeSidebar);
    el('sidebar-overlay').addEventListener('click', closeSidebar);

    function openSidebar() {
        el('sidebar').classList.add('open');
        el('sidebar-overlay').classList.add('open');
    }

    function closeSidebar() {
        el('sidebar').classList.remove('open');
        el('sidebar-overlay').classList.remove('open');
    }

    // --- Modal ---

    const modalOverlay = el('modal-overlay');
    const modalClose = el('modal-close');

    function openModal() {
        modalOverlay.classList.remove('hidden');
        setTimeout(() => modalOverlay.classList.add('visible'), 10);
    }

    function closeModal() {
        modalOverlay.classList.remove('visible');
        setTimeout(() => modalOverlay.classList.add('hidden'), 300);
    }

    modalClose.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeModal();
    });

    // --- Add Course (+ button) ---

    let browsePath = [];

    el('add-course-btn').addEventListener('click', () => {
        el('modal-title').textContent = 'Add Course';
        el('browse-view').classList.remove('hidden');
        el('tag-editor').classList.add('hidden');
        browsePath = [];
        browseDirectory('');
        openModal();
    });

    async function browseDirectory(path) {
        const list = el('browse-list');
        const pathDisplay = el('browse-path');

        list.innerHTML = '<div class="browse-loading">Loading...</div>';

        const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
        const dirs = await api(url);

        if (!dirs || dirs.error) {
            list.innerHTML = '<div class="browse-empty">Unable to browse this directory</div>';
            return;
        }

        // Path breadcrumb
        if (path) {
            pathDisplay.innerHTML = `
                <button class="browse-back" data-path="">Root</button>
                <span class="sep">/</span>
                <span>${esc(path.split('/').pop())}</span>
            `;
            pathDisplay.querySelector('.browse-back').addEventListener('click', () => browseDirectory(''));
        } else {
            pathDisplay.innerHTML = '<span>Select a course folder</span>';
        }

        if (!dirs.length) {
            list.innerHTML = '<div class="browse-empty">No subdirectories found</div>';
            return;
        }

        list.innerHTML = dirs.map(d => `
            <div class="browse-item${d.has_videos ? ' has-videos' : ''}" data-path="${esc(d.path)}" data-name="${esc(d.name)}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <div class="browse-item-info">
                    <span class="browse-item-name">${esc(d.name)}</span>
                    ${d.has_videos ? '<span class="browse-item-hint">Contains videos</span>' : ''}
                </div>
                <div class="browse-item-actions">
                    ${d.has_videos || d.is_root ? '' : ''}
                    <button class="browse-select-btn" title="Select as course">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                    <button class="browse-enter-btn" title="Browse">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                </div>
            </div>
        `).join('');

        list.querySelectorAll('.browse-enter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = btn.closest('.browse-item');
                browseDirectory(item.dataset.path);
            });
        });

        list.querySelectorAll('.browse-select-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = btn.closest('.browse-item');
                selectCourseFolder(item.dataset.path, item.dataset.name);
            });
        });

        // Double-click to enter directory
        list.querySelectorAll('.browse-item').forEach(item => {
            item.addEventListener('dblclick', () => {
                browseDirectory(item.dataset.path);
            });
        });
    }

    async function selectCourseFolder(fullPath, folderName) {
        // Find the course in our courses list that matches this folder
        const matchingCourse = state.courses.find(c => {
            // Check if any library + course path matches the full path
            return fullPath.endsWith(c.path) || fullPath.includes(c.path);
        });

        if (matchingCourse) {
            openTagEditor(matchingCourse);
        } else {
            // Course not found in current scan - it might be a subfolder that's not a direct course
            // Just open tag editor with the folder path
            openTagEditorForPath(fullPath, folderName);
        }
    }

    // --- Tag Editor ---

    let currentTagCoursePath = '';
    let currentTagCourseLibrary = '';

    async function openTagEditor(course) {
        currentTagCoursePath = course.path;
        currentTagCourseLibrary = course.library;

        el('modal-title').textContent = 'Edit Tags';
        el('browse-view').classList.add('hidden');
        el('tag-editor').classList.remove('hidden');
        el('tag-course-name').textContent = course.name;

        // Load existing tags and all available tags
        const [courseTags, allTags] = await Promise.all([
            api(`/api/courses/${encodeURIComponent(course.path)}/tags`),
            api('/api/tags'),
        ]);

        state.allTags = allTags || { sources: [], categories: [] };

        // Populate datalists for autocomplete
        el('source-suggestions').innerHTML = state.allTags.sources.map(s => `<option value="${esc(s)}">`).join('');
        el('category-suggestions').innerHTML = state.allTags.categories.map(c => `<option value="${esc(c)}">`).join('');

        // Pre-fill source suggestion from parent_hint
        if (course.parent_hint && !courseTags.some(t => t.tag_type === 'source')) {
            el('tag-source-input').value = course.parent_hint;
        } else {
            el('tag-source-input').value = '';
        }
        el('tag-category-input').value = '';

        // Render existing tags
        renderTagPills('tag-sources-list', courseTags.filter(t => t.tag_type === 'source'));
        renderTagPills('tag-categories-list', courseTags.filter(t => t.tag_type === 'category'));

        if (modalOverlay.classList.contains('hidden')) openModal();
    }

    function openTagEditorForPath(fullPath, name) {
        // For folders that aren't in the courses list yet, we need to compute the relative path
        // This is a best-effort approach
        currentTagCoursePath = name;
        currentTagCourseLibrary = '';

        el('modal-title').textContent = 'Edit Tags';
        el('browse-view').classList.add('hidden');
        el('tag-editor').classList.remove('hidden');
        el('tag-course-name').textContent = name;
        el('tag-source-input').value = '';
        el('tag-category-input').value = '';
        el('tag-sources-list').innerHTML = '';
        el('tag-categories-list').innerHTML = '';

        if (modalOverlay.classList.contains('hidden')) openModal();
    }

    function renderTagPills(containerId, tags) {
        const container = el(containerId);
        if (!tags.length) {
            container.innerHTML = '<span class="tag-empty">None</span>';
            return;
        }
        container.innerHTML = tags.map(t => `
            <span class="tag-pill">
                ${esc(t.tag_value)}
                <button class="tag-remove" data-id="${t.id}" data-value="${esc(t.tag_value)}">&times;</button>
            </span>
        `).join('');

        container.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', async () => {
                await api(`/api/courses/${encodeURIComponent(currentTagCoursePath)}/tags/${btn.dataset.id}`, {
                    method: 'DELETE',
                });
                // Refresh
                const course = state.courses.find(c => c.path === currentTagCoursePath);
                if (course) openTagEditor(course);
            });
        });
    }

    el('add-source-btn').addEventListener('click', () => addTag('source'));
    el('tag-source-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addTag('source'); }
    });

    el('add-category-btn').addEventListener('click', () => addTag('category'));
    el('tag-category-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addTag('category'); }
    });

    async function addTag(type) {
        const input = el(`tag-${type}-input`);
        const value = input.value.trim();
        if (!value || !currentTagCoursePath) return;

        const res = await api(`/api/courses/${encodeURIComponent(currentTagCoursePath)}/tags`, {
            method: 'POST',
            body: { tag_type: type, tag_value: value },
        });

        if (res && res.ok) {
            input.value = '';
            // Refresh tag editor
            const course = state.courses.find(c => c.path === currentTagCoursePath);
            if (course) openTagEditor(course);
        }
    }

    el('tag-done-btn').addEventListener('click', () => {
        closeModal();
        loadDashboard();
    });

    // --- Keyboard Shortcuts ---

    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (!state.currentLesson) return;
        if (state.currentLesson.type === 'document') return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                video.currentTime = Math.max(0, video.currentTime - 10);
                showOverlayIcon('-10s');
                break;
            case 'ArrowRight':
                e.preventDefault();
                video.currentTime = Math.min(video.duration, video.currentTime + 10);
                showOverlayIcon('+10s');
                break;
            case 'j':
                video.currentTime = Math.max(0, video.currentTime - 10);
                showOverlayIcon('-10s');
                break;
            case 'l':
                video.currentTime = Math.min(video.duration, video.currentTime + 10);
                showOverlayIcon('+10s');
                break;
            case 'f':
                fullscreenBtn.click();
                break;
            case 'm':
                video.muted = !video.muted;
                updateVolumeUI();
                showOverlayIcon(video.muted ? '&#128263;' : '&#128266;');
                break;
            case 'n':
                if (e.shiftKey) {
                    prevBtn.click();
                } else {
                    nextBtn.click();
                }
                break;
            case ',':
                if (video.paused) video.currentTime = Math.max(0, video.currentTime - 1/30);
                break;
            case '.':
                if (video.paused) video.currentTime = Math.min(video.duration, video.currentTime + 1/30);
                break;
        }
    });

    // Global search shortcut
    document.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            searchInput.focus();
            openSidebar();
        }
    });

    // --- Escape ---
    function esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // --- Settings ---

    async function loadSettings() {
        showView('settings');
        el('sidebar-nav').classList.remove('hidden');
        el('course-sidebar').classList.add('hidden');
        el('breadcrumb').innerHTML = '<span class="sep">/</span><span>Settings</span>';

        const data = await api('/api/settings');
        if (!data) return;

        state.settings = data.settings || {};
        state.libraries = data.libraries || [];

        // Account
        el('settings-username').value = data.username || '';
        el('settings-current-pw').value = '';
        el('settings-new-pw').value = '';
        el('settings-confirm-pw').value = '';
        hideMsg('account-msg');

        // Libraries
        renderLibraries();

        // Theme
        const theme = state.settings.theme || 'dark';
        el('theme-options').querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });

        // Density
        const density = state.settings.ui_density || 'comfortable';
        el('density-options').querySelectorAll('.density-option').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.density === density);
        });

        // Playback
        el('settings-speed').value = state.settings.playback_speed || '1';
        const autoAdv = state.settings.auto_advance !== 'false';
        const toggle = el('auto-advance-toggle');
        toggle.classList.toggle('active', autoAdv);
        toggle.dataset.value = autoAdv;
    }

    function renderLibraries() {
        const list = el('libraries-list');
        if (!state.libraries.length) {
            list.innerHTML = '<div class="library-empty">No libraries configured. The default course directory will be used.</div>';
            return;
        }
        list.innerHTML = state.libraries.map(lib => `
            <div class="library-item">
                <div class="library-info">
                    <span class="library-label">${esc(lib.label)}</span>
                    <span class="library-path">${esc(lib.path)}</span>
                </div>
                <button class="library-remove" data-id="${lib.id}" title="Remove">&times;</button>
            </div>
        `).join('');

        list.querySelectorAll('.library-remove').forEach(btn => {
            btn.addEventListener('click', async () => {
                await api(`/api/libraries/${btn.dataset.id}`, { method: 'DELETE' });
                await loadSettings();
            });
        });
    }

    function showMsg(id, text, isError) {
        const msg = el(id);
        msg.textContent = text;
        msg.className = 'settings-msg ' + (isError ? 'msg-error' : 'msg-success');
        msg.classList.remove('hidden');
    }

    function hideMsg(id) {
        el(id).classList.add('hidden');
    }

    // Save account
    el('save-account-btn').addEventListener('click', async () => {
        const currentPw = el('settings-current-pw').value;
        const newPw = el('settings-new-pw').value;
        const confirmPw = el('settings-confirm-pw').value;
        const username = el('settings-username').value.trim();

        if (!currentPw) {
            showMsg('account-msg', 'Current password is required', true);
            return;
        }
        if (newPw && newPw !== confirmPw) {
            showMsg('account-msg', 'New passwords do not match', true);
            return;
        }

        const res = await fetch('/api/account', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF, 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ current_password: currentPw, username, new_password: newPw }),
        });
        const data = await res.json();

        if (res.ok) {
            showMsg('account-msg', 'Account updated successfully', false);
            el('settings-current-pw').value = '';
            el('settings-new-pw').value = '';
            el('settings-confirm-pw').value = '';
            if (data.username) {
                qs('.user-label').textContent = data.username;
            }
        } else {
            showMsg('account-msg', data.error || 'Failed to update account', true);
        }
    });

    // Add library
    el('add-library-btn').addEventListener('click', async () => {
        const path = el('library-path-input').value.trim();
        const label = el('library-label-input').value.trim();

        if (!path) {
            showMsg('library-msg', 'Path is required', true);
            return;
        }

        const res = await fetch('/api/libraries', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF, 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ path, label }),
        });
        const data = await res.json();

        if (res.ok) {
            el('library-path-input').value = '';
            el('library-label-input').value = '';
            hideMsg('library-msg');
            await loadSettings();
        } else {
            showMsg('library-msg', data.error || 'Failed to add library', true);
        }
    });

    // Theme selection
    el('theme-options').addEventListener('click', e => {
        const btn = e.target.closest('.theme-option');
        if (!btn) return;
        const theme = btn.dataset.theme;
        el('theme-options').querySelectorAll('.theme-option').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyTheme(theme);
        state.settings.theme = theme;
        api('/api/settings', { method: 'PUT', body: { theme } });
    });

    // Density selection
    el('density-options').addEventListener('click', e => {
        const btn = e.target.closest('.density-option');
        if (!btn) return;
        const density = btn.dataset.density;
        el('density-options').querySelectorAll('.density-option').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyDensity(density);
        state.settings.ui_density = density;
        api('/api/settings', { method: 'PUT', body: { ui_density: density } });
    });

    // Playback speed default
    el('settings-speed').addEventListener('change', () => {
        const speed = el('settings-speed').value;
        state.settings.playback_speed = speed;
        api('/api/settings', { method: 'PUT', body: { playback_speed: speed } });
    });

    // Auto-advance toggle
    el('auto-advance-toggle').addEventListener('click', () => {
        const toggle = el('auto-advance-toggle');
        const current = toggle.dataset.value === 'true';
        const newVal = !current;
        toggle.dataset.value = newVal;
        toggle.classList.toggle('active', newVal);
        state.settings.auto_advance = String(newVal);
        api('/api/settings', { method: 'PUT', body: { auto_advance: String(newVal) } });
    });

    // Apply theme/density
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme || 'dark');
    }

    function applyDensity(density) {
        document.documentElement.setAttribute('data-density', density || 'comfortable');
    }

    // --- Init ---

    async function init() {
        const data = await api('/api/settings');
        if (data) {
            state.settings = data.settings || {};
            applyTheme(state.settings.theme);
            applyDensity(state.settings.ui_density);
            if (state.settings.playback_speed) {
                video.playbackRate = parseFloat(state.settings.playback_speed);
                speedBtn.textContent = state.settings.playback_speed + 'x';
            }
        }
        loadDashboard();
    }

    init();

})();
