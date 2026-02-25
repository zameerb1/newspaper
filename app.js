// === Configuration ===
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const OPENAI_API = 'https://api.openai.com/v1/chat/completions';
const CORS_PROXY = 'https://corsproxy.io/?url=';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CACHED_DAYS = 7;

// API key: loaded from URL hash (#key=...) or localStorage, or prompted
function getApiKey() {
    // Check URL hash first: index.html#key=sk-proj-...
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const hashKey = hashParams.get('key');
    if (hashKey) {
        localStorage.setItem('dailyscoop-apikey', hashKey);
        // Clean the URL so key isn't visible
        history.replaceState(null, '', window.location.pathname);
        return hashKey;
    }
    // Check localStorage
    const stored = localStorage.getItem('dailyscoop-apikey');
    if (stored) return stored;
    return null;
}

let OPENAI_API_KEY = getApiKey();

// === State ===
let currentDate = new Date();

// === DOM References ===
const frontPage = document.getElementById('frontPage');
const loadingOverlay = document.getElementById('loadingOverlay');
const dateDisplay = document.getElementById('dateDisplay');
const prevDayBtn = document.getElementById('prevDay');
const nextDayBtn = document.getElementById('nextDay');
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
const errorBanner = document.getElementById('errorBanner');
const errorMessage = document.getElementById('errorMessage');
const errorRetry = document.getElementById('errorRetry');
const errorDismiss = document.getElementById('errorDismiss');

// === Initialization ===
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initDateNav();
    initApiKeyModal();
    loadNews(currentDate);
});

function initApiKeyModal() {
    const modal = document.getElementById('apiKeyModal');
    const input = document.getElementById('apiKeyInput');
    const saveBtn = document.getElementById('apiKeySave');
    const skipBtn = document.getElementById('apiKeySkip');

    // Show modal if no API key and not previously skipped
    if (!OPENAI_API_KEY && !localStorage.getItem('dailyscoop-skipai')) {
        modal.style.display = 'flex';
    }

    saveBtn.addEventListener('click', () => {
        const key = input.value.trim();
        if (key) {
            OPENAI_API_KEY = key;
            localStorage.setItem('dailyscoop-apikey', key);
            modal.style.display = 'none';
            // Reload to get AI-rewritten content
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k.startsWith('dailyscoop-2')) localStorage.removeItem(k);
            }
            loadNews(currentDate);
        }
    });

    skipBtn.addEventListener('click', () => {
        localStorage.setItem('dailyscoop-skipai', 'true');
        modal.style.display = 'none';
    });

    // Enter key submits
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveBtn.click();
    });
}

// === Theme ===
function initTheme() {
    const saved = localStorage.getItem('dailyscoop-theme');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        themeIcon.textContent = '🌙';
    }
    themeToggle.addEventListener('click', () => {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) {
            document.documentElement.removeAttribute('data-theme');
            themeIcon.textContent = '☀️';
            localStorage.setItem('dailyscoop-theme', 'light');
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            themeIcon.textContent = '🌙';
            localStorage.setItem('dailyscoop-theme', 'dark');
        }
    });
}

// === Date Navigation ===
function initDateNav() {
    prevDayBtn.addEventListener('click', () => {
        currentDate.setDate(currentDate.getDate() - 1);
        loadNews(currentDate);
    });
    nextDayBtn.addEventListener('click', () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (currentDate < tomorrow) {
            currentDate.setDate(currentDate.getDate() + 1);
            loadNews(currentDate);
        }
    });
    errorRetry.addEventListener('click', () => {
        errorBanner.style.display = 'none';
        loadNews(currentDate);
    });
    errorDismiss.addEventListener('click', () => {
        errorBanner.style.display = 'none';
    });
}

function formatDateDisplay(date) {
    return date.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
}

function formatDateKey(date) {
    const year = date.getFullYear();
    const month = date.toLocaleString('en-US', { month: 'long' });
    const day = date.getDate();
    return `${year}_${month}_${day}`;
}

function isToday(date) {
    const today = new Date();
    return date.toDateString() === today.toDateString();
}

// === Caching ===
function getCached(dateKey) {
    try {
        const raw = localStorage.getItem(`dailyscoop-${dateKey}`);
        if (!raw) return null;
        const { data, timestamp } = JSON.parse(raw);
        // For today, expire after TTL; for past days, keep indefinitely
        if (isToday(currentDate) && Date.now() - timestamp > CACHE_TTL_MS) return null;
        return data;
    } catch {
        return null;
    }
}

function setCache(dateKey, data) {
    try {
        localStorage.setItem(`dailyscoop-${dateKey}`, JSON.stringify({
            data, timestamp: Date.now()
        }));
        evictOldCache();
    } catch { /* localStorage full, that's ok */ }
}

function evictOldCache() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('dailyscoop-') && key !== 'dailyscoop-theme') {
            try {
                const { timestamp } = JSON.parse(localStorage.getItem(key));
                keys.push({ key, timestamp });
            } catch { /* skip */ }
        }
    }
    keys.sort((a, b) => a.timestamp - b.timestamp);
    while (keys.length > MAX_CACHED_DAYS) {
        localStorage.removeItem(keys.shift().key);
    }
}

// === Main Load Function ===
async function loadNews(date) {
    const dateKey = formatDateKey(date);
    dateDisplay.textContent = formatDateDisplay(date);
    frontPage.innerHTML = '';
    loadingOverlay.classList.remove('hidden');
    errorBanner.style.display = 'none';

    // Check cache first
    const cached = getCached(dateKey);
    if (cached) {
        loadingOverlay.classList.add('hidden');
        renderNewspaper(cached);
        return;
    }

    try {
        // 1. Fetch WikiText
        const wikitext = await fetchCurrentEvents(dateKey);
        if (!wikitext) {
            // Try yesterday
            if (isToday(date)) {
                showError('Today\'s news isn\'t posted yet — showing yesterday\'s.');
                currentDate.setDate(currentDate.getDate() - 1);
                loadNews(currentDate);
                return;
            }
            showError('No news found for this date.');
            loadingOverlay.classList.add('hidden');
            return;
        }

        // 2. Parse stories
        const stories = parseWikiText(wikitext);
        if (stories.length === 0) {
            showError('No stories found for this date.');
            loadingOverlay.classList.add('hidden');
            return;
        }

        // 3. Fetch images and rewrite headlines in parallel
        const [images, rewritten] = await Promise.all([
            fetchImages(stories),
            rewriteHeadlines(stories)
        ]);

        // 4. Merge data
        const processed = mergeData(stories, images, rewritten);

        // 5. Rank and layout
        const layout = rankStories(processed);

        // 6. Cache and render
        setCache(dateKey, layout);
        loadingOverlay.classList.add('hidden');
        renderNewspaper(layout);

    } catch (err) {
        console.error('Failed to load news:', err);
        loadingOverlay.classList.add('hidden');
        showError('Failed to load news. Check your connection and try again.');
    }
}

// === Wikipedia Fetch ===
async function fetchCurrentEvents(dateKey) {
    const url = `${WIKI_API}?action=parse&page=Portal:Current_events/${dateKey}&format=json&prop=wikitext&origin=*`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) return null;
    return data.parse.wikitext['*'];
}

// === WikiText Parser ===
function parseWikiText(wikitext) {
    const lines = wikitext.split('\n');
    const stories = [];
    let currentCategory = null;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip template/comment lines
        if (trimmed.startsWith('{{') || trimmed.startsWith('}}') || trimmed.startsWith('<!--') || trimmed === '') continue;

        // Category headers: '''Category Name''' or ;[[Category Name]]
        const catBoldMatch = trimmed.match(/^'''([^']+)'''\s*$/);
        const catSemiMatch = trimmed.match(/^;\s*\[\[([^\]|]+)/);
        if (catBoldMatch) {
            currentCategory = catBoldMatch[1].trim();
            continue;
        }
        if (catSemiMatch) {
            currentCategory = catSemiMatch[1].trim();
            continue;
        }

        // Top-level story (single *)
        if (/^\*[^*]/.test(trimmed)) {
            const rawText = trimmed.replace(/^\*\s*/, '');

            // Extract wiki links
            const wikiLinks = [];
            const wikiLinkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
            let m;
            while ((m = wikiLinkRe.exec(rawText)) !== null) {
                wikiLinks.push({ article: m[1].trim(), display: (m[2] || m[1]).trim() });
            }

            // Extract external source links
            const sourceLinks = [];
            const extRe = /\[https?:\/\/(\S+)\s+([^\]]*)\]/g;
            while ((m = extRe.exec(rawText)) !== null) {
                sourceLinks.push({ url: 'https://' + m[1], text: m[2].replace(/''/g, '') });
            }

            // Plain text: strip wiki markup
            const plainText = rawText
                .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
                .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
                .replace(/''+/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            stories.push({
                category: currentCategory || 'General',
                rawText,
                plainText,
                wikiLinks,
                sourceLinks,
                subItems: []
            });
            continue;
        }

        // Sub-items (** or ***)
        if ((trimmed.startsWith('**')) && stories.length > 0) {
            const subRaw = trimmed.replace(/^\*+\s*/, '');
            const subPlain = subRaw
                .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
                .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
                .replace(/''+/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            // Also extract wiki links from sub-items for image fetching
            const subWikiLinks = [];
            const wikiLinkRe2 = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
            let m2;
            while ((m2 = wikiLinkRe2.exec(subRaw)) !== null) {
                subWikiLinks.push({ article: m2[1].trim(), display: (m2[2] || m2[1]).trim() });
            }

            // Extract external source links from sub-items
            const subSourceLinks = [];
            const extRe2 = /\[https?:\/\/(\S+)\s+([^\]]*)\]/g;
            while ((m2 = extRe2.exec(subRaw)) !== null) {
                subSourceLinks.push({ url: 'https://' + m2[1], text: m2[2].replace(/''/g, '') });
            }

            stories[stories.length - 1].subItems.push(subPlain);
            stories[stories.length - 1].wikiLinks.push(...subWikiLinks);
            stories[stories.length - 1].sourceLinks.push(...subSourceLinks);
        }
    }

    return stories;
}

// === Image Fetching ===
async function fetchImages(stories) {
    // Collect all unique article titles
    const allTitles = [];
    const titleToStoryIdx = {};

    stories.forEach((story, idx) => {
        const titles = story.wikiLinks
            .map(l => l.article)
            .filter(t => !t.includes(':') && !t.includes('#')) // Skip namespaced/anchor links
            .slice(0, 3); // Max 3 per story

        titles.forEach(title => {
            if (!allTitles.includes(title)) {
                allTitles.push(title);
                titleToStoryIdx[title] = idx;
            }
        });
    });

    if (allTitles.length === 0) return {};

    // Batch into groups of 20 (API limit)
    const imageMap = {}; // storyIndex -> imageUrl
    const batches = [];
    for (let i = 0; i < allTitles.length; i += 20) {
        batches.push(allTitles.slice(i, i + 20));
    }

    try {
        const results = await Promise.all(batches.map(async (batch) => {
            const titles = batch.map(t => encodeURIComponent(t)).join('|');
            const url = `${WIKI_API}?action=query&titles=${titles}&prop=pageimages&pithumbsize=600&format=json&origin=*`;
            const res = await fetch(url);
            return res.json();
        }));

        results.forEach(data => {
            if (!data.query || !data.query.pages) return;
            Object.values(data.query.pages).forEach(page => {
                if (page.thumbnail && page.thumbnail.source) {
                    const title = page.title;
                    const storyIdx = titleToStoryIdx[title];
                    if (storyIdx !== undefined && !imageMap[storyIdx]) {
                        imageMap[storyIdx] = {
                            url: page.thumbnail.source,
                            width: page.thumbnail.width,
                            height: page.thumbnail.height
                        };
                    }
                }
            });
        });
    } catch (err) {
        console.error('Image fetch failed:', err);
    }

    return imageMap;
}

// === OpenAI Rewriting ===
async function rewriteHeadlines(stories) {
    const storyTexts = stories.map((s, i) => {
        const fullText = s.plainText + (s.subItems.length ? '\n  Details: ' + s.subItems.join('; ') : '');
        return `[${i}] Category: ${s.category}\nText: ${fullText}`;
    }).join('\n\n');

    try {
        const res = await fetch(CORS_PROXY + encodeURIComponent(OPENAI_API), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: `You are the editor of The Daily Scoop, a newspaper for smart 14-year-olds. Your job is to make world news genuinely interesting and understandable.

Write like a great teacher who respects their students' intelligence — never talk down, never bore them. Use vivid, concrete language. Make complex events easy to picture.

For each numbered news item, produce:
- "headline": punchy, active voice, max 12 words, makes you want to read more
- "summary": 2-3 sentences explaining what happened AND why it's interesting, with concrete details a teen can picture
- "whyItMatters": 1 sentence connecting it to teens' lives (e.g., "This could change how your phone works" or "This affects what you pay for snacks")

Return a JSON object: { "stories": [ { "index": 0, "headline": "...", "summary": "...", "whyItMatters": "..." }, ... ] }

Rules:
- Keep it factually accurate
- Never use clickbait or sensationalize
- Never use slang, emojis, or talk down
- Write like the New York Times but for smart teens`
                    },
                    {
                        role: 'user',
                        content: `Rewrite these ${stories.length} news items:\n\n${storyTexts}`
                    }
                ],
                temperature: 0.7,
                max_tokens: 4000
            })
        });

        const data = await res.json();
        if (data.error) {
            console.error('OpenAI error:', data.error);
            return null;
        }

        const content = data.choices[0].message.content;
        const parsed = JSON.parse(content);
        return parsed.stories || parsed;
    } catch (err) {
        console.error('OpenAI rewrite failed:', err);
        return null;
    }
}

// === Merge Data ===
function mergeData(stories, images, rewritten) {
    return stories.map((story, i) => {
        const ai = rewritten ? rewritten.find(r => r.index === i) : null;
        return {
            category: story.category,
            headline: ai ? ai.headline : story.plainText.slice(0, 80),
            summary: ai ? ai.summary : story.plainText,
            whyItMatters: ai ? ai.whyItMatters : null,
            image: images[i] || null,
            wikiLinks: story.wikiLinks,
            sourceLinks: story.sourceLinks,
            detailCount: story.subItems.length + story.wikiLinks.length
        };
    });
}

// === Story Ranking ===
function rankStories(stories) {
    // Sort by detail count (importance proxy)
    const sorted = [...stories].sort((a, b) => b.detailCount - a.detailCount);

    // Prefer stories with images for hero/medium
    const withImages = sorted.filter(s => s.image);
    const withoutImages = sorted.filter(s => !s.image);

    // Hero: best story with an image, or just the best story
    let hero, medium, briefs, remaining;

    if (withImages.length > 0) {
        hero = withImages[0];
        const rest = sorted.filter(s => s !== hero);
        // Medium: next 3 (prefer with images)
        medium = [];
        const restWithImg = rest.filter(s => s.image);
        const restNoImg = rest.filter(s => !s.image);
        medium = restWithImg.slice(0, 3);
        if (medium.length < 3) {
            medium = medium.concat(restNoImg.slice(0, 3 - medium.length));
        }
        const used = new Set([hero, ...medium]);
        remaining = sorted.filter(s => !used.has(s));
    } else {
        hero = sorted[0];
        medium = sorted.slice(1, 4);
        remaining = sorted.slice(4);
    }

    briefs = remaining.slice(0, 5);
    const sectionStories = remaining.slice(5);

    // Group remaining by category
    const sections = {};
    sectionStories.forEach(s => {
        if (!sections[s.category]) sections[s.category] = [];
        sections[s.category].push(s);
    });

    return { hero, medium, briefs, sections };
}

// === Rendering ===
function renderNewspaper(layout) {
    const { hero, medium, briefs, sections } = layout;
    frontPage.innerHTML = '';

    // Determine if we have enough stories for full layout
    const hasBriefs = briefs && briefs.length > 0;

    // Hero story — if no briefs, let it span full width
    if (hero) {
        const heroClass = hasBriefs ? 'hero-story' : 'hero-story hero-full';
        frontPage.appendChild(createStoryElement(hero, heroClass));
    }

    // Briefs column
    if (hasBriefs) {
        const briefsCol = document.createElement('div');
        briefsCol.className = 'briefs-column fade-in';
        briefsCol.innerHTML = `<div class="briefs-header">News Briefs</div>`;
        briefs.forEach(story => {
            const item = document.createElement('div');
            item.className = 'brief-item';
            item.innerHTML = `
                <div class="story-category" style="color: ${getCategoryColor(story.category)}">${story.category}</div>
                <div class="story-headline"><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(story.wikiLinks[0]?.article || '')}" target="_blank">${escapeHtml(story.headline)}</a></div>
                <div class="story-summary">${escapeHtml(story.summary)}</div>
            `;
            briefsCol.appendChild(item);
        });
        frontPage.appendChild(briefsCol);
    }

    // Medium stories
    if (medium) {
        medium.forEach(story => {
            frontPage.appendChild(createStoryElement(story, 'medium-story'));
        });
    }

    // Section groups
    if (sections) {
        Object.entries(sections).forEach(([category, stories]) => {
            const group = document.createElement('div');
            group.className = 'section-group fade-in';
            group.innerHTML = `
                <div class="section-title" style="color: ${getCategoryColor(category)}">${category}</div>
                <div class="section-stories"></div>
            `;
            const grid = group.querySelector('.section-stories');
            stories.forEach(story => {
                grid.appendChild(createStoryElement(story, 'story'));
            });
            frontPage.appendChild(group);
        });
    }
}

function createStoryElement(story, className) {
    const article = document.createElement('article');
    article.className = `story ${className} fade-in`;

    const wikiLink = story.wikiLinks[0]?.article
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(story.wikiLinks[0].article)}`
        : '#';

    let imageHtml = '';
    if (story.image) {
        imageHtml = `
            <div class="story-image-wrap">
                <img class="story-image" src="${story.image.url}" alt="" loading="lazy">
            </div>
        `;
    }

    let whyHtml = '';
    if (story.whyItMatters) {
        whyHtml = `<div class="story-why">${escapeHtml(story.whyItMatters)}</div>`;
    }

    let sourceHtml = '';
    if (story.sourceLinks && story.sourceLinks.length > 0) {
        const links = story.sourceLinks
            .slice(0, 2)
            .map(s => `<a href="${escapeHtml(s.url)}" target="_blank">${escapeHtml(s.text)}</a>`)
            .join(' · ');
        sourceHtml = `<div class="story-source">${links} · <a href="${wikiLink}" target="_blank">Wikipedia</a></div>`;
    } else {
        sourceHtml = `<div class="story-source"><a href="${wikiLink}" target="_blank">Read more on Wikipedia →</a></div>`;
    }

    article.innerHTML = `
        <div class="story-category" style="color: ${getCategoryColor(story.category)}">${escapeHtml(story.category)}</div>
        ${imageHtml}
        <div class="story-headline"><a href="${wikiLink}" target="_blank">${escapeHtml(story.headline)}</a></div>
        <div class="story-summary">${escapeHtml(story.summary)}</div>
        ${whyHtml}
        ${sourceHtml}
    `;

    return article;
}

// === Utility Functions ===
function getCategoryColor(category) {
    const cat = (category || '').toLowerCase();
    if (cat.includes('armed') || cat.includes('conflict')) return 'var(--accent-armed-conflicts)';
    if (cat.includes('disaster') || cat.includes('accident')) return 'var(--accent-disasters)';
    if (cat.includes('politic') || cat.includes('election')) return 'var(--accent-politics)';
    if (cat.includes('international')) return 'var(--accent-international)';
    if (cat.includes('law') || cat.includes('crime')) return 'var(--accent-law)';
    if (cat.includes('business') || cat.includes('econom')) return 'var(--accent-business)';
    if (cat.includes('sport')) return 'var(--accent-sports)';
    if (cat.includes('art') || cat.includes('culture')) return 'var(--accent-arts)';
    if (cat.includes('health') || cat.includes('environment')) return 'var(--accent-health)';
    if (cat.includes('science') || cat.includes('tech')) return 'var(--accent-science)';
    return 'var(--accent-default)';
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showError(msg) {
    errorMessage.textContent = msg;
    errorBanner.style.display = 'flex';
}
